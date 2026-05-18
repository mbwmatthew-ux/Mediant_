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

CRITICAL: The student is playing this passage starting from measure ${startMeasure}. That is the absolute measure number of the FIRST measure visible at the top-left of the score. NUMBER ALL MEASURES SEQUENTIALLY FROM ${startMeasure}: the first measure is ${startMeasure}, the next is ${startMeasure + 1}, and so on. Do NOT trust printed measure numbers in the image — handwritten fingerings and ornaments often look like numbers. Trust the sequential count from ${startMeasure} only.

Time signature (if known): ${timeSig}. If you see a different time signature in the score, use what you see.

For every measure visible on the page, list the printed notes:
- pitch: scientific pitch notation (e.g. "D3", "F#4", "Bb3"). Use null for rests.
- beat: position within the measure as a decimal (1.0 = downbeat, 2.0 = beat 2, 1.5 = "and" of 1). For 12/8, count 1.0, 1.33, 1.67, 2.0, … (each eighth = 0.33 of a beat group). For 4/4, beats are 1, 2, 3, 4.
- duration_beats: how many beats this note lasts.
- articulation: "staccato", "tenuto", "accent", "slur_start", "slur_end", or null.
- dynamic: "pp", "p", "mp", "mf", "f", "ff", "cresc", "dim", or null. Carry forward — only mark when notation changes.

If a note is illegible or ambiguous, OMIT it — do not guess. It is correct to return measures with fewer notes than the full notation.

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
    }
  ]
}`

  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        visionPart as { type: 'image' | 'document'; source: { type: 'base64'; media_type: string; data: string } },
        { type: 'text', text: prompt },
      ],
    }],
  })
  const raw = (msg.content[0] as { type: string; text: string }).text ?? ''
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

STRICT RULES:
- Report ONLY events where you are 80%+ confident of the pitch you heard. Skip ambiguous moments entirely — better to skip than to guess.
- For each event: time_sec (when in the recording it occurred, seconds from 0:00), pitches (an array of scientific-pitch-notation strings like "D3" or "F#4"; usually 1 pitch for monophonic instruments, occasionally 2+ for double-stops/chords), and confidence (your 0-100 confidence).
- Use scientific pitch notation: middle C = "C4". Cello open strings: C2, G2, D3, A3. Violin open strings: G3, D4, A4, E5.
- Cover the WHOLE recording from 0:00 to the end — do not stop after the first few seconds.
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

  // Filter to confidence >= 80, sort by time
  const events = (parsed.events ?? [])
    .filter(e => typeof e?.time_sec === 'number' && Array.isArray(e.pitches) && e.pitches.length > 0)
    .filter(e => (e.confidence ?? 100) >= 80)
    .map(e => ({
      time_sec: e.time_sec!,
      pitches: e.pitches!.map(String),
      confidence: e.confidence ?? 100,
      loudness: (e as AudioEvent).loudness ?? null,
    }))
    .sort((a, b) => a.time_sec - b.time_sec)

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

  // Find anchor: first audio event whose pitch matches one of the first measure's pitches.
  const firstMeasurePitches = new Set(
    (score.measures[0].notes ?? []).map(n => n.pitch).filter((p): p is string => !!p)
  )
  let anchorEvent: AudioEvent = audio.events[0]
  for (const ev of audio.events) {
    if (ev.pitches.some(p => firstMeasurePitches.has(p))) { anchorEvent = ev; break }
  }
  const tAnchor = anchorEvent.time_sec

  // Estimate seconds per measure. Prefer the score's tempo marking + time sig.
  // Fallback: divide remaining duration by visible measure count.
  let secPerMeasure: number
  const playedDuration = Math.max(0.5, audio.audio_duration_sec - tAnchor)
  const visibleCount   = score.measures.length
  if (audio.tempo_estimate_bpm && score.time_signature) {
    const bpm = audio.tempo_estimate_bpm
    const [num, denom] = score.time_signature.split('/').map(s => parseInt(s, 10))
    if (num && denom) {
      // bpm is typically quarter-note BPM. measure_seconds = (num / denom) * (60 / bpm) * 4
      secPerMeasure = (num / denom) * (60 / bpm) * 4
    } else {
      secPerMeasure = playedDuration / visibleCount
    }
  } else {
    secPerMeasure = playedDuration / visibleCount
  }
  // Clamp to sane range
  secPerMeasure = Math.max(1.0, Math.min(15.0, secPerMeasure))

  // Bucket events to measures
  const validMeasures = new Set(score.measures.map(m => m.number))
  const aligned: AlignedEvent[] = []
  for (const ev of audio.events) {
    const m = startMeasure + Math.round((ev.time_sec - tAnchor) / secPerMeasure)
    if (validMeasures.has(m)) aligned.push({ ...ev, measure: m })
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

  if (playedMeasures.length === 0) {
    console.warn('[compareAndCoach] no measures aligned with audio')
    return []
  }

  const measureBlocks = playedMeasures.map(m => {
    const written = m.notes.length === 0
      ? '(no notes parsed)'
      : m.notes.map(n => {
          const parts = [`${n.pitch ?? 'rest'} @ beat ${n.beat} (${n.duration_beats}b)`]
          if (n.articulation) parts.push(n.articulation)
          if (n.dynamic)      parts.push(n.dynamic)
          return parts.join(' ')
        }).join(', ')
    const heard = (eventsByMeasure.get(m.number) ?? [])
      .map(e => `${e.pitches.join('/')} @ ${e.time_sec.toFixed(2)}s${e.loudness ? ' [' + e.loudness + ']' : ''}`)
      .join(', ')
    return `Measure ${m.number}:\n  WRITTEN: ${written}\n  HEARD:   ${heard}`
  }).join('\n\n')

  const validMeasuresList = Array.from(validMeasures).sort((a, b) => a - b)

  const prompt = `You are a master ${instrument} teacher giving specific, grounded feedback to a student on "${pieceTitle}" by ${composer}.

Below is a measure-by-measure comparison of WRITTEN notation (from the score) and HEARD audio events (transcribed from the student's recording). Use ONLY this data — do not invent details that aren't here.

${measureBlocks}

Tempo: ${tempo.bpm ?? '?'} BPM, ${tempo.steadiness ?? '?'}.
Key: ${score.key_signature ?? '?'}. Time signature: ${score.time_signature ?? '?'}.

YOUR TASK:
Identify 0–4 SPECIFIC issues that are clearly evident in the comparison above. For each issue, you MUST cite the specific note(s) — like "written B♭3 on beat 1, heard B♮3 (sharp by a half-step)" or "written staccato eighth notes, heard legato".

HARD RULES:
- Every "measure" field MUST be one of: [${validMeasuresList.join(', ')}].
- If you cannot cite a specific note-level comparison from the data, DROP that flag.
- Returning {"flags": []} is correct for a clean performance. Do NOT invent issues to fill space.
- Use confidence 80+ only.
- "type" must be one of: intonation, timing, rhythm, articulation, dynamics, voicing.

Return JSON only (no markdown):
{
  "flags": [
    {
      "measure": <int from the allowed list>,
      "beat": <number, 1-based>,
      "type": "<intonation|timing|rhythm|articulation|dynamics|voicing>",
      "confidence": <80-100>,
      "title": "<6–10 word specific title naming the note/beat>",
      "raw_detail": "<one sentence citing exactly what was written vs what was heard>",
      "body": "<3-sentence warm coaching paragraph: what happened, why it matters, one specific practice technique>"
    }
  ]
}`

  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })
  const raw = (msg.content[0] as { type: string; text: string }).text ?? ''
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
    if ((f.confidence ?? 100) < 80) continue
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
    const videoFileUri = await uploadVideoToGemini(videoBytes, videoMimeType, googleApiKey)

    // Step 1 + Step 2 in parallel
    const [score, audio] = await Promise.all([
      scoreBytes && resolvedScoreMime
        ? readScoreNotes(scoreBytes, resolvedScoreMime, safeStart, instrument ?? 'instrument', timeSig ?? '4/4')
        : Promise.resolve({ key_signature: null, time_signature: null, tempo_marking: null, measures: [] } as ScoreReading),
      transcribeAudio(videoFileUri, videoMimeType, instrument ?? 'instrument', googleApiKey),
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
