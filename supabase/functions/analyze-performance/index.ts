import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const GEMINI_MODEL = 'gemini-2.5-pro'
const CLAUDE_MODEL = 'claude-sonnet-4-6'

// ── Types ──────────────────────────────────────────────────────────────────

interface ScoreNote {
  pitch: string | null         // e.g. "D3", "F#4"; null for rests
  beat: number                 // 1.0 = downbeat
  duration_beats: number
  articulation: string | null
  dynamic: string | null
}
interface ScoreMeasure { number: number; notes: ScoreNote[] }
interface ScoreReading {
  key_signature: string | null
  time_signature: string | null
  tempo_marking: string | null
  measures: ScoreMeasure[]
}

interface AudioEvent {
  time_sec: number
  pitches: string[]
  confidence: number
  loudness?: string | null     // "soft" | "medium" | "loud"
  articulation?: string | null // optional shape hint
}
interface AudioTranscription {
  audio_duration_sec: number
  events: AudioEvent[]
  tempo_estimate_bpm: number | null
  tempo_steadiness: string | null
}

interface AlignedEvent extends AudioEvent { measure: number }

interface CoachingFlag {
  measure: number
  type: string
  title: string
  raw_detail: string
  body: string
  confidence: number
  timestamp_start: number | null
  timestamp_end: number | null
  spot: null
  spot_angle: number
}

// ── Helpers ───────────────────────────────────────────────────────────────

const VISUAL_SCORE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function bytesToBase64(bytes: Uint8Array): string {
  // btoa(String.fromCharCode(...)) blows the stack on large arrays; chunk it.
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function extractJsonObject(raw: string): unknown | null {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const start = stripped.indexOf('{')
  const end   = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try { return JSON.parse(stripped.slice(start, end + 1)) } catch { return null }
}

// ── Step 1: Claude reads the score image into structured notes ────────────

async function readScoreNotes(
  scoreBytes: Uint8Array,
  scoreMimeType: string,
  startMeasure: number,
  instrument: string,
  timeSig: string,
): Promise<ScoreReading> {
  const base64 = bytesToBase64(scoreBytes)
  let visionPart: unknown
  if (scoreMimeType === 'application/pdf') {
    visionPart = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
  } else if (CLAUDE_IMAGE_TYPES.has(scoreMimeType)) {
    visionPart = { type: 'image', source: { type: 'base64', media_type: scoreMimeType, data: base64 } }
  } else {
    // HEIC and others not supported by Claude vision. Return empty score.
    console.warn('[readScoreNotes] unsupported score mime for Claude:', scoreMimeType)
    return { key_signature: null, time_signature: null, tempo_marking: null, measures: [] }
  }

  const prompt = `You are an expert music engraver reading a sheet music image for a ${instrument} student.

MEASURE NUMBERING — CRITICAL:
The student's recording starts at measure ${startMeasure}. The FIRST complete measure visible at the top-left of the score is measure ${startMeasure}. Number all measures sequentially from there: ${startMeasure}, ${startMeasure + 1}, ${startMeasure + 2}, …
Do NOT trust any printed numbers in the image — handwritten fingerings, rehearsal letters, and ornaments all look like numbers. Count measures visually: count how many barlines you cross, starting from 0 at the left edge.

Time signature (if known): ${timeSig}. Use what you see in the image if different.

WHAT TO RETURN — CRITICAL:
Return EVERY measure bar-to-bar across the ENTIRE page, even if you cannot read its notes. A measure with illegible content must still appear with an empty notes array:
  {"number": ${startMeasure + 2}, "notes": []}

For each note you CAN read:
- pitch: scientific pitch notation ("D3", "F#4", "Bb3"). Use null for rests or if pitch is ambiguous.
- beat: position within the measure (1.0 = downbeat, 2.0 = beat 2, 1.5 = "and" of 1). For 12/8, each eighth-note group = 0.33 beats.
- duration_beats: number of beats this note lasts.
- articulation: "staccato", "tenuto", "accent", "slur_start", "slur_end", or null.
- dynamic: "pp", "p", "mp", "mf", "f", "ff", "cresc", "dim", or null (carry forward; only mark changes).

Do NOT omit measures. Include every measure with whatever notes you can read. An empty notes array is correct when the measure is unreadable.

Return JSON only (no markdown):
{
  "key_signature": "<e.g. D minor>",
  "time_signature": "<e.g. 12/8>",
  "tempo_marking": "<e.g. Lento, quarter = 56>",
  "measures": [
    {
      "number": ${startMeasure},
      "notes": [
        {"pitch": "D3", "beat": 1.0, "duration_beats": 1.5, "articulation": null, "dynamic": "p"}
      ]
    },
    {
      "number": ${startMeasure + 1},
      "notes": []
    }
  ]
}`

  let raw: string
  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      messages: [{
        role: 'user',
        content: [
          visionPart as { type: 'image' | 'document'; source: { type: 'base64'; media_type: string; data: string } },
          { type: 'text', text: prompt },
        ],
      }],
    })
    raw = (msg.content[0] as { type: string; text: string }).text ?? ''
  } catch (err) {
    console.error('[readScoreNotes] Claude API error:', (err as Error).message)
    return { key_signature: null, time_signature: null, tempo_marking: null, measures: [] }
  }
  const parsed = extractJsonObject(raw) as ScoreReading | null
  if (!parsed) {
    console.error('[readScoreNotes] no JSON in response:', raw.slice(0, 500))
    return { key_signature: null, time_signature: null, tempo_marking: null, measures: [] }
  }

  // Sanity: first measure number must equal startMeasure. If Claude got that
  // wrong, renumber sequentially from startMeasure.
  const measures = (parsed.measures ?? []).filter(m => Array.isArray(m?.notes))
  if (measures.length > 0 && measures[0].number !== startMeasure) {
    console.warn('[readScoreNotes] renumbering: first measure was', measures[0].number, 'expected', startMeasure)
    for (let i = 0; i < measures.length; i++) measures[i].number = startMeasure + i
  }
  const totalNotes = measures.reduce((acc, m) => acc + m.notes.length, 0)
  console.log('[readScoreNotes] parsed', measures.length, 'measures with', totalNotes, 'total notes')
  if (measures.length > 0) {
    console.log('[readScoreNotes] sample first measure:', JSON.stringify(measures[0]).slice(0, 400))
  }

  return {
    key_signature:  parsed.key_signature  ?? null,
    time_signature: parsed.time_signature ?? null,
    tempo_marking:  parsed.tempo_marking  ?? null,
    measures,
  }
}

// ── Step 2: Gemini transcribes the audio into pitch events ────────────────

async function uploadVideoToGemini(videoBytes: Uint8Array, mimeType: string, apiKey: string): Promise<string> {
  const boundary = `gem_${Date.now()}`
  const metadata = JSON.stringify({ file: { displayName: 'practice-recording' } })
  const CRLF = '\r\n'
  const pre  = `--${boundary}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${metadata}${CRLF}--${boundary}${CRLF}Content-Type: ${mimeType}${CRLF}${CRLF}`
  const post = `${CRLF}--${boundary}--`
  const preB  = new TextEncoder().encode(pre)
  const postB = new TextEncoder().encode(post)
  const body = new Uint8Array(preB.length + videoBytes.length + postB.length)
  body.set(preB)
  body.set(videoBytes, preB.length)
  body.set(postB, preB.length + videoBytes.length)

  const uploadRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}&uploadType=multipart`,
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
  )
  if (!uploadRes.ok) throw new Error(`Gemini upload failed: ${await uploadRes.text()}`)
  const { file } = await uploadRes.json()

  const fileId = (file.name as string).split('/').pop()!
  let state: string = file.state
  let attempts = 0
  while (state === 'PROCESSING' && attempts < 15) {
    await new Promise(r => setTimeout(r, 3000))
    const pollRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${fileId}?key=${apiKey}`)
    state = (await pollRes.json()).state
    attempts++
  }
  if (state !== 'ACTIVE') throw new Error(`Gemini file never became active (state: ${state})`)
  return file.uri as string
}

async function transcribeAudio(
  videoFileUri: string,
  videoMimeType: string,
  instrument: string,
  apiKey: string,
): Promise<AudioTranscription> {
  const prompt = `Listen carefully to this ${instrument} performance. Your job is to transcribe the audio into a list of pitch events with timestamps.

RULES:
- Report events where you are 60%+ confident of the pitch. Include borderline events with lower confidence (60–79) rather than omitting them — the caller will filter. Better to over-report than under-report.
- For each event: time_sec (when in the recording it occurred, seconds from 0:00), pitches (an array of scientific-pitch-notation strings like "D3" or "F#4"; usually 1 pitch for monophonic instruments, occasionally 2+ for double-stops/chords), and confidence (your 0-100 confidence).
- Use scientific pitch notation: middle C = "C4". Cello open strings: C2, G2, D3, A3. Violin open strings: G3, D4, A4, E5.
- Cover the WHOLE recording from 0:00 to the end — do not stop after the first few seconds. Report events every 0.5–2 seconds throughout.
- Also estimate the overall tempo in BPM (beats per minute) and whether tempo is "steady" or "wavering".

Return JSON only (no markdown):
{
  "audio_duration_sec": <number>,
  "events": [
    {"time_sec": 0.00, "pitches": ["D3"], "confidence": 95, "loudness": "medium"}
  ],
  "tempo_estimate_bpm": <number or null>,
  "tempo_steadiness": "steady" | "wavering"
}`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { fileData: { mimeType: videoMimeType, fileUri: videoFileUri } },
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          maxOutputTokens: 16384,
        },
      }),
    },
  )
  if (!res.ok) throw new Error(`Gemini transcribeAudio failed: ${await res.text()}`)
  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined
  if (!text) {
    console.error('[transcribeAudio] empty response:', JSON.stringify(data).slice(0, 600))
    throw new Error('Gemini returned no text from transcribeAudio')
  }
  const parsed = extractJsonObject(text) as Partial<AudioTranscription> | null
  if (!parsed) throw new Error('transcribeAudio: could not parse JSON')

  const rawEvents = parsed.events ?? []
  const events = rawEvents
    .filter(e => typeof e?.time_sec === 'number' && Array.isArray(e.pitches) && e.pitches.length > 0)
    .filter(e => (e.confidence ?? 100) >= 55)
    .map(e => ({
      time_sec: e.time_sec!,
      pitches: e.pitches!.map(String),
      confidence: e.confidence ?? 100,
      loudness: (e as AudioEvent).loudness ?? null,
    }))
    .sort((a, b) => a.time_sec - b.time_sec)
  console.log('[transcribeAudio] raw events:', rawEvents.length, 'after filter:', events.length, 'tempo:', parsed.tempo_estimate_bpm)
  if (events.length > 0) {
    console.log('[transcribeAudio] first 3 events:', JSON.stringify(events.slice(0, 3)))
    console.log('[transcribeAudio] last event time:', events[events.length - 1]?.time_sec)
  }

  return {
    audio_duration_sec: parsed.audio_duration_sec ?? (events[events.length - 1]?.time_sec ?? 0) + 2,
    events,
    tempo_estimate_bpm: parsed.tempo_estimate_bpm ?? null,
    tempo_steadiness:   parsed.tempo_steadiness   ?? null,
  }
}

// ── Step 3: Anchor & align (pure code) ─────────────────────────────────────

function anchorAndAlign(
  score: ScoreReading,
  audio: AudioTranscription,
  startMeasure: number,
): { aligned: AlignedEvent[]; secPerMeasure: number; alignmentRanges: Array<{ measure: number; start: number; end: number }> } {
  if (audio.events.length === 0 || score.measures.length === 0) {
    return { aligned: [], secPerMeasure: 0, alignmentRanges: [] }
  }

  // Anchor: student recordings start when they start playing, so events[0] ≈ startMeasure.
  // Pitch-matching is fragile (notes may be empty); just use the first event.
  const tAnchor = audio.events[0].time_sec

  // secPerMeasure: primary = audio duration / measure count (reliable for practice recordings).
  // Only override with tempo-based estimate if duration/count gives an unreasonable value.
  const playedDuration = Math.max(1, audio.audio_duration_sec - tAnchor)
  const visibleCount   = score.measures.length
  let secPerMeasure    = playedDuration / visibleCount

  if (audio.tempo_estimate_bpm && score.time_signature) {
    const bpm = audio.tempo_estimate_bpm
    const [num, denom] = score.time_signature.split('/').map(s => parseInt(s, 10))
    if (num && denom) {
      const tempoBased = (num / denom) * (60 / bpm) * 4
      // Prefer tempo only when duration/count is pathological and tempo is sane
      if ((secPerMeasure < 1.0 || secPerMeasure > 20.0) && tempoBased >= 1.0 && tempoBased <= 20.0) {
        secPerMeasure = tempoBased
      }
    }
  }
  secPerMeasure = Math.max(1.0, Math.min(20.0, secPerMeasure))
  console.log('[anchorAndAlign] duration/count secPerMeasure:', (playedDuration / visibleCount).toFixed(2), 'tempoEstimate:', audio.tempo_estimate_bpm, 'using:', secPerMeasure.toFixed(2))

  // Bucket events to measures — clamp to valid range rather than dropping.
  // This keeps events even when secPerMeasure is slightly off.
  const validMeasures = new Set(score.measures.map(m => m.number))
  const lastMeasure = score.measures[score.measures.length - 1].number
  const aligned: AlignedEvent[] = []
  for (const ev of audio.events) {
    const mRaw = startMeasure + Math.round((ev.time_sec - tAnchor) / secPerMeasure)
    const m = Math.max(startMeasure, Math.min(lastMeasure, mRaw))
    if (validMeasures.has(m)) aligned.push({ ...ev, measure: m })
  }

  // Fallback: if anchor/tempo math produced nothing, distribute events proportionally
  // across visible measures so compareAndCoach always has something to work with.
  if (aligned.length === 0 && audio.events.length > 0) {
    console.warn('[anchorAndAlign] tempo anchor failed — using proportional fallback')
    const totalDur = Math.max(1, audio.audio_duration_sec)
    const measureNums = score.measures.map(m => m.number)
    for (const ev of audio.events) {
      const fraction = Math.min(1, ev.time_sec / totalDur)
      const idx = Math.min(score.measures.length - 1, Math.floor(fraction * score.measures.length))
      aligned.push({ ...ev, measure: measureNums[idx] })
    }
  }

  // Build measure → time range map for the coach
  const rangesByMeasure = new Map<number, { start: number; end: number }>()
  for (const ev of aligned) {
    const existing = rangesByMeasure.get(ev.measure)
    if (existing) {
      rangesByMeasure.set(ev.measure, {
        start: Math.min(existing.start, ev.time_sec),
        end:   Math.max(existing.end,   ev.time_sec),
      })
    } else {
      rangesByMeasure.set(ev.measure, { start: ev.time_sec, end: ev.time_sec })
    }
  }
  // Ensure each range is at least secPerMeasure wide
  const alignmentRanges = Array.from(rangesByMeasure.entries())
    .map(([measure, r]) => ({
      measure,
      start: r.start,
      end:   Math.max(r.end, r.start + secPerMeasure * 0.9),
    }))
    .sort((a, b) => a.measure - b.measure)

  return { aligned, secPerMeasure, alignmentRanges }
}

// ── Step 4: Claude compares score vs. performance and writes flags ─────────

async function compareAndCoach(
  score: ScoreReading,
  aligned: AlignedEvent[],
  alignmentRanges: Array<{ measure: number; start: number; end: number }>,
  tempo: { bpm: number | null; steadiness: string | null },
  pieceTitle: string,
  composer: string,
  instrument: string,
): Promise<CoachingFlag[]> {
  // Build per-measure comparison
  const eventsByMeasure = new Map<number, AudioEvent[]>()
  for (const ev of aligned) {
    if (!eventsByMeasure.has(ev.measure)) eventsByMeasure.set(ev.measure, [])
    eventsByMeasure.get(ev.measure)!.push(ev)
  }
  const validMeasures = new Set(score.measures.map(m => m.number))
  const playedMeasures = score.measures.filter(m => eventsByMeasure.has(m.number))

  // If still nothing (score.measures empty), generate tempo-only flags from raw audio
  if (playedMeasures.length === 0) {
    console.warn('[compareAndCoach] no score measures with aligned events')
    return []
  }

  // For rhythm analysis: get the measure start time from alignmentRanges so we can
  // express event times as offsets within the measure (beat positions).
  const rangeStartMap = new Map(alignmentRanges.map(r => [r.measure, r.start]))

  const measureBlocks = playedMeasures.map(m => {
    const written = m.notes.length === 0
      ? '(score notation not parsed — analyze event spacing for rhythm/timing issues)'
      : m.notes.map(n => {
          const parts = [`${n.pitch ?? 'rest'} @ beat ${n.beat} (${n.duration_beats}b)`]
          if (n.articulation) parts.push(n.articulation)
          if (n.dynamic)      parts.push(n.dynamic)
          return parts.join(' ')
        }).join(', ')
    const mStart = rangeStartMap.get(m.number) ?? 0
    const heard = (eventsByMeasure.get(m.number) ?? [])
      .map(e => {
        const offsetSec = (e.time_sec - mStart).toFixed(2)
        return `${e.pitches.join('/')} @ +${offsetSec}s${e.loudness ? ' [' + e.loudness + ']' : ''}`
      })
      .join(', ')
    return `Measure ${m.number}:\n  WRITTEN: ${written}\n  HEARD:   ${heard || '(no events)'}`
  }).join('\n\n')

  const validMeasuresList = Array.from(validMeasures).sort((a, b) => a - b)

  const prompt = `You are a master ${instrument} teacher giving feedback to a student on "${pieceTitle}" by ${composer}.

Below is a measure-by-measure record of what is WRITTEN in the score and what was HEARD in the student's recording. Use this data to identify issues. Audio transcription is imperfect — sparse "heard" lines mean some notes weren't transcribed, not that nothing was played.

${measureBlocks}

Tempo: ${tempo.bpm ?? '?'} BPM, ${tempo.steadiness ?? '?'}.
Key: ${score.key_signature ?? '?'}. Time signature: ${score.time_signature ?? '?'}.

YOUR TASK:
Identify 1–4 issues that are reasonably supported by the data above. Order of preference for what to flag:
1. **Specific pitch mismatch** (e.g. written B♭3 on beat 1, heard B♮3 — sharp by a half-step). When you can cite this, do so.
2. **Rhythm/timing patterns** — look at the HEARD event offsets within each measure. Events should be evenly spaced relative to the time signature. Uneven gaps (e.g., first note rushed, or long silence) = timing flag. Cite the specific +Ns offset that looks off.
3. **Coverage gaps** — a measure that says "(no events)" or has very few events may indicate hesitation, dropped notes, or a stop-and-restart.
4. **Tempo issues overall** (e.g. tempo too slow/fast, steadiness "wavering").

HARD RULES:
- Every "measure" field MUST be one of: [${validMeasuresList.join(', ')}].
- If the recording sounds genuinely clean and you have NO basis for concern, return fewer or zero flags.
- For an amateur student practice recording, returning zero flags is usually WRONG — find what you can. Don't be timid.
- "type" must be one of: intonation, timing, rhythm, articulation, dynamics, voicing.
- raw_detail should cite the evidence (which note/beat/measure and what's off). If the evidence is rhythm-based or tempo-based rather than a specific pitch, say so clearly.

Return JSON only (no markdown):
{
  "flags": [
    {
      "measure": <int from the allowed list>,
      "beat": <number, 1-based, or null if measure-level>,
      "type": "<intonation|timing|rhythm|articulation|dynamics|voicing>",
      "confidence": <70-100>,
      "title": "<6–10 word specific title>",
      "raw_detail": "<one sentence: the evidence>",
      "body": "<3-sentence warm coaching paragraph: what happened, why it matters, one specific practice technique>"
    }
  ]
}`

  let raw: string
  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    })
    raw = (msg.content[0] as { type: string; text: string }).text ?? ''
  } catch (err) {
    console.error('[compareAndCoach] Claude API error:', (err as Error).message)
    return []
  }
  const parsed = extractJsonObject(raw) as { flags?: Array<Partial<CoachingFlag> & { beat?: number }> } | null
  if (!parsed) {
    console.error('[compareAndCoach] no JSON in response:', raw.slice(0, 500))
    return []
  }

  const rangeMap = new Map(alignmentRanges.map(r => [r.measure, r]))
  const flags: CoachingFlag[] = []
  for (const f of (parsed.flags ?? [])) {
    if (typeof f.measure !== 'number' || !validMeasures.has(f.measure)) {
      console.warn('[compareAndCoach] dropping flag with invalid measure:', f.measure)
      continue
    }
    if ((f.confidence ?? 100) < 60) continue
    if (!f.type || !f.title || !f.raw_detail || !f.body) continue

    const range = rangeMap.get(f.measure)
    flags.push({
      measure:         f.measure,
      type:            String(f.type),
      title:           String(f.title),
      raw_detail:      String(f.raw_detail),
      body:            String(f.body),
      confidence:      f.confidence ?? 100,
      timestamp_start: range?.start ?? null,
      timestamp_end:   range?.end   ?? null,
      spot:            null,
      spot_angle:      0,
    })
  }
  return flags
}

// ── Handler ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) throw new Error('Unauthorized')

    const { videoPath, videoMimeType, scorePath, scoreMimeType, pieceTitle, composer, timeSig, instrument, startMeasure } = await req.json()
    if (!videoPath || !videoMimeType) throw new Error('videoPath and videoMimeType are required')

    const startMeasureNum = startMeasure ? parseInt(startMeasure, 10) : 1
    const safeStart = Number.isFinite(startMeasureNum) && startMeasureNum >= 1 ? startMeasureNum : 1

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Download video
    const { data: videoBlob, error: vErr } = await admin.storage.from('recordings').download(videoPath)
    if (vErr || !videoBlob) throw new Error(`Video download failed: ${vErr?.message}`)
    const videoBytes = new Uint8Array(await videoBlob.arrayBuffer())

    // Download score (if visual)
    let scoreBytes: Uint8Array | null = null
    let resolvedScoreMime: string | null = null
    if (scorePath && scoreMimeType && VISUAL_SCORE_TYPES.has(scoreMimeType)) {
      const { data: sBlob } = await admin.storage.from('sheet-music').download(scorePath)
      if (sBlob) {
        scoreBytes = new Uint8Array(await sBlob.arrayBuffer())
        resolvedScoreMime = scoreMimeType
      }
    }

    const googleApiKey = Deno.env.get('GOOGLE_AI_API_KEY')!

    // Upload video to Gemini (sequential with file processing)
    console.log('[analyze-performance] uploading video to Gemini, bytes:', videoBytes.length, 'mime:', videoMimeType)
    let videoFileUri: string
    try {
      videoFileUri = await uploadVideoToGemini(videoBytes, videoMimeType, googleApiKey)
    } catch (err) {
      console.error('[analyze-performance] video upload failed:', (err as Error).message)
      throw new Error(`Video upload to Gemini failed: ${(err as Error).message}`)
    }
    console.log('[analyze-performance] video uploaded:', videoFileUri)

    // Step 1 + Step 2 in parallel — each function is internally error-resilient
    // so a single failure doesn't cancel the other.
    console.log('[analyze-performance] starting parallel score-read + audio-transcribe. scoreBytes?', !!scoreBytes, 'mime:', resolvedScoreMime)
    const [score, audio] = await Promise.all([
      scoreBytes && resolvedScoreMime
        ? readScoreNotes(scoreBytes, resolvedScoreMime, safeStart, instrument ?? 'instrument', timeSig ?? '4/4')
            .catch(err => {
              console.error('[analyze-performance] readScoreNotes threw:', (err as Error).message)
              return { key_signature: null, time_signature: null, tempo_marking: null, measures: [] } as ScoreReading
            })
        : Promise.resolve({ key_signature: null, time_signature: null, tempo_marking: null, measures: [] } as ScoreReading),
      transcribeAudio(videoFileUri, videoMimeType, instrument ?? 'instrument', googleApiKey)
        .catch(err => {
          console.error('[analyze-performance] transcribeAudio threw:', (err as Error).message)
          return { audio_duration_sec: 0, events: [], tempo_estimate_bpm: null, tempo_steadiness: null } as AudioTranscription
        }),
    ])
    console.log('[analyze-performance] score measures:', score.measures.length, 'starting at', score.measures[0]?.number ?? '?')
    console.log('[analyze-performance] audio events (high-conf):', audio.events.length, 'duration:', audio.audio_duration_sec, 'tempo:', audio.tempo_estimate_bpm)

    // Step 3: anchor & align
    const { aligned, secPerMeasure, alignmentRanges } = anchorAndAlign(score, audio, safeStart)
    console.log('[analyze-performance] aligned events:', aligned.length, 'sec/measure:', secPerMeasure.toFixed(2))
    console.log('[analyze-performance] measures with audio:', alignmentRanges.map(r => r.measure))

    // Step 4: compare & coach
    const flags = await compareAndCoach(
      score,
      aligned,
      alignmentRanges,
      { bpm: audio.tempo_estimate_bpm, steadiness: audio.tempo_steadiness },
      pieceTitle ?? 'this piece',
      composer  ?? 'the composer',
      instrument ?? 'musician',
    )
    console.log('[analyze-performance] coaching flags:', flags.map(f => `m.${f.measure} (${f.type})`))

    // Overall score: simple inverse-flag heuristic, capped 50–98
    const baseScore = Math.max(50, Math.min(98, 95 - flags.length * 6))

    const { data: take, error: insertError } = await admin
      .from('takes')
      .insert({
        user_id:         user.id,
        piece_title:     pieceTitle ?? 'Untitled',
        piece_composer:  composer   ?? 'Unknown',
        video_path:      videoPath,
        video_mime_type: videoMimeType,
        score_path:      scorePath ?? null,
        score:           baseScore,
        flags,
        measure_layout:  score.measures.length > 0 ? score : null,
        audio_alignment: alignmentRanges.length > 0 ? alignmentRanges : null,
      })
      .select('id')
      .single()
    if (insertError) throw new Error(`DB insert failed: ${insertError.message}`)

    return new Response(JSON.stringify({ takeId: take.id, score: baseScore, flags }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    console.error('[analyze-performance] error:', (err as Error).message)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
