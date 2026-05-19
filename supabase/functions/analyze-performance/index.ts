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
- pitch: scientific pitch notation ("D3", "F#4", "Bb3"). Use the literal string "rest" for written rests. Use null ONLY when you can see a note-head but cannot determine its pitch (e.g. smudged, covered by fingering). Do NOT use null for rests — rests are not notes, they are explicit silences.
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
        {"pitch": "D3", "beat": 1.0, "duration_beats": 1.5, "articulation": null, "dynamic": "p"},
        {"pitch": "rest", "beat": 2.5, "duration_beats": 0.5, "articulation": null, "dynamic": null}
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
- Also estimate the overall tempo. Report BPM as the **conductor's beat rate** — the pulse you feel most naturally. For compound meters like 12/8 or 6/8, that is the dotted-quarter pulse (not the eighth note). For simple meters like 4/4 or 3/4, it is the quarter-note pulse. Also report whether tempo is "steady" or "wavering".

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
  const tAnchor = audio.events[0].time_sec

  // secPerMeasure: tempo-based is PRIMARY — the score's marked tempo tells us how long
  // each measure lasts and is more reliable than duration/visible_count, because the score
  // photo shows the whole page even though the student only played a portion of it.
  const playedDuration = Math.max(1, audio.audio_duration_sec - tAnchor)
  let secPerMeasure: number
  let secPerMeasureSource = 'fallback'

  if (audio.tempo_estimate_bpm && score.time_signature) {
    const bpm = audio.tempo_estimate_bpm
    const [num, denom] = score.time_signature.split('/').map(s => parseInt(s, 10))
    if (num && denom) {
      // Beats per measure depends on whether the meter is compound or simple.
      // Compound: 6/8, 9/8, 12/8 — beat unit is the dotted quarter (3 eighth notes).
      // Simple:   2/4, 3/4, 4/4, 2/2 — beat unit is the quarter (or half for cut time).
      const isCompound = num % 3 === 0 && num / 3 >= 2 && denom >= 8
      const beatsPerMeasure = isCompound ? num / 3 : num
      // Gemini reports the perceived pulse rate. For compound meters this is the
      // dotted-quarter rate; for simple it is the quarter rate.
      // secPerMeasure = beats_per_measure × seconds_per_beat
      const tempoBased = beatsPerMeasure * (60 / bpm)
      if (tempoBased >= 1.0 && tempoBased <= 30.0) {
        secPerMeasure = tempoBased
        secPerMeasureSource = `tempo(${isCompound ? 'compound' : 'simple'},${beatsPerMeasure}beats)`
      }
    }
  }

  // Fallback: only when tempo unavailable. Use a generous per-measure default (4s) rather
  // than dividing by visible_count — the score photo may show many more measures than played.
  if (!secPerMeasure!) {
    // Prefer 4s if no tempo; clamp to sane range based on duration
    secPerMeasure = Math.min(playedDuration / 2, 4.0)
    secPerMeasureSource = 'default-4s'
  }
  secPerMeasure = Math.max(1.0, Math.min(30.0, secPerMeasure))

  // KEY FIX: estimate how many measures the student actually played and cap validMeasures
  // to that range. The score photo may show 40+ measures but the student played 8.
  const estimatedMeasuresPlayed = Math.ceil(playedDuration / secPerMeasure)
  const lastPlayedMeasureNum    = Math.min(
    startMeasure + estimatedMeasuresPlayed - 1,
    score.measures[score.measures.length - 1].number,
  )
  console.log('[anchorAndAlign] secPerMeasure:', secPerMeasure.toFixed(2), 'source:', secPerMeasureSource, '| tempoEstimate:', audio.tempo_estimate_bpm, '| estimatedMeasures:', estimatedMeasuresPlayed, '| lastPlayed:', lastPlayedMeasureNum)

  const validMeasures = new Set(score.measures.filter(m => m.number <= lastPlayedMeasureNum).map(m => m.number))
  const lastMeasure   = lastPlayedMeasureNum
  const aligned: AlignedEvent[] = []
  for (const ev of audio.events) {
    const mRaw = startMeasure + Math.round((ev.time_sec - tAnchor) / secPerMeasure)
    const m = Math.max(startMeasure, Math.min(lastMeasure, mRaw))
    if (validMeasures.has(m)) aligned.push({ ...ev, measure: m })
  }

  // Fallback: if anchor/tempo math produced nothing, distribute events proportionally
  // across the PLAYED range (not all visible measures).
  if (aligned.length === 0 && audio.events.length > 0) {
    console.warn('[anchorAndAlign] tempo anchor failed — using proportional fallback')
    const totalDur = Math.max(1, audio.audio_duration_sec)
    const playedMeasureNums = score.measures.filter(m => validMeasures.has(m.number)).map(m => m.number)
    if (playedMeasureNums.length > 0) {
      for (const ev of audio.events) {
        const fraction = Math.min(1, ev.time_sec / totalDur)
        const idx = Math.min(playedMeasureNums.length - 1, Math.floor(fraction * playedMeasureNums.length))
        aligned.push({ ...ev, measure: playedMeasureNums[idx] })
      }
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
          const pitchLabel = n.pitch === null ? '(unclear)' : n.pitch
          const parts = [`${pitchLabel} @ beat ${n.beat} (${n.duration_beats}b)`]
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

IMPORTANT: In the WRITTEN column, "(unclear)" means the score had a note-head but its pitch could not be read — it is NOT a rest. Only "rest" means a written rest. Do NOT flag a student for playing during an "(unclear)" note, and do NOT assume "(unclear)" means silence.

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

// ── Beat-level alignment (used when Modal worker returns beat_times) ─────────

function alignWithBeats(
  events: AudioEvent[],
  beatTimes: number[],
  beatsPerMeasure: number,
  startMeasure: number,
  endMeasure: number | null,
): AlignedEvent[] {
  if (!beatTimes.length || !events.length) return []
  const maxMeasure = endMeasure ?? Infinity

  const aligned: AlignedEvent[] = []
  for (const ev of events) {
    const t = ev.time_sec
    // Find the last beat that started at or before this event
    let beatIdx = 0
    for (let i = 0; i < beatTimes.length; i++) {
      if (beatTimes[i] <= t) beatIdx = i
      else break
    }
    const measureOffset = Math.floor(beatIdx / beatsPerMeasure)
    const measure = startMeasure + measureOffset
    if (measure > maxMeasure) continue
    aligned.push({ ...ev, measure })
  }
  return aligned
}

function buildAlignmentRanges(
  aligned: AlignedEvent[],
  secPerMeasure: number,
): Array<{ measure: number; start: number; end: number }> {
  const map = new Map<number, { start: number; end: number }>()
  for (const ev of aligned) {
    const existing = map.get(ev.measure)
    if (existing) {
      map.set(ev.measure, {
        start: Math.min(existing.start, ev.time_sec),
        end:   Math.max(existing.end,   ev.time_sec),
      })
    } else {
      map.set(ev.measure, { start: ev.time_sec, end: ev.time_sec })
    }
  }
  return Array.from(map.entries())
    .map(([measure, r]) => ({
      measure,
      start: r.start,
      end:   Math.max(r.end, r.start + Math.max(0.5, secPerMeasure * 0.9)),
    }))
    .sort((a, b) => a.measure - b.measure)
}

// ── Modal worker call ─────────────────────────────────────────────────────

interface ModalAudioResult {
  audio_duration_sec: number
  events: Array<AudioEvent & { measure?: number; end_sec?: number; midi?: number; source?: string }>
  tempo_estimate_bpm: number | null
  tempo_steadiness: string | null
  beat_times: number[]
  onset_times: number[]
  source: string
}

interface ModalScoreResult {
  key_signature: string | null
  time_signature: string | null
  tempo_marking: string | null
  measures: ScoreMeasure[]
  source: string
  error?: string
}

interface ModalWorkerResult {
  audio?: ModalAudioResult
  score?: ModalScoreResult
  beats?: { tempo_bpm: number; beat_times: number[]; onset_times: number[]; duration_sec: number }
  error?: string
}

async function callModalWorker(
  workerUrl: string,
  payload: Record<string, unknown>,
): Promise<ModalWorkerResult> {
  const res = await fetch(workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),  // 90s: cold start + processing; fallback to Gemini if slow
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    throw new Error(`Modal worker HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json() as Promise<ModalWorkerResult>
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

    const {
      videoPath, videoMimeType,
      scorePath, scoreMimeType,
      pieceTitle, composer,
      timeSig, instrument,
      startMeasure, endMeasure,
    } = await req.json()
    if (!videoPath || !videoMimeType) throw new Error('videoPath and videoMimeType are required')

    const startMeasureNum = startMeasure ? parseInt(String(startMeasure), 10) : 1
    const safeStart = Number.isFinite(startMeasureNum) && startMeasureNum >= 1 ? startMeasureNum : 1
    const safeEnd: number | null = endMeasure ? Math.max(safeStart, parseInt(String(endMeasure), 10)) : null

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Compute beats_per_measure for alignment
    const tSig = (timeSig ?? '4/4').toString()
    let beatsPerMeasure = 4
    try {
      const [num, denom] = tSig.split('/').map(Number)
      const isCompound = num % 3 === 0 && num / 3 >= 2 && denom >= 8
      beatsPerMeasure = isCompound ? Math.round(num / 3) : num
    } catch { /* keep 4 */ }

    // Determine score type
    const XML_MIMES = new Set(['application/vnd.recordare.musicxml+xml', 'application/vnd.recordare.musicxml', 'text/xml', 'application/xml'])
    const isXmlScore = scoreMimeType && (
      XML_MIMES.has(scoreMimeType) ||
      scoreMimeType === 'application/octet-stream' && (
        scorePath?.endsWith('.xml') || scorePath?.endsWith('.musicxml') || scorePath?.endsWith('.mxl')
      )
    )
    const isVisualScore = scoreMimeType && VISUAL_SCORE_TYPES.has(scoreMimeType)

    const modalUrl = Deno.env.get('MODAL_WORKER_URL')
    const googleApiKey = Deno.env.get('GOOGLE_AI_API_KEY')!

    // Generate signed URLs for Modal worker
    let videoSignedUrl: string | null = null
    let scoreSignedUrl: string | null = null
    if (modalUrl) {
      const { data: vSigned } = await admin.storage.from('recordings')
        .createSignedUrl(videoPath, 3600)
      videoSignedUrl = vSigned?.signedUrl ?? null

      if (scorePath) {
        const { data: sSigned } = await admin.storage.from('sheet-music')
          .createSignedUrl(scorePath, 3600)
        scoreSignedUrl = sSigned?.signedUrl ?? null
      }
    }

    let score: ScoreReading = { key_signature: null, time_signature: null, tempo_marking: null, measures: [] }
    let audio: AudioTranscription = { audio_duration_sec: 0, events: [], tempo_estimate_bpm: null, tempo_steadiness: null }
    let aligned: AlignedEvent[] = []
    let alignmentRanges: Array<{ measure: number; start: number; end: number }> = []
    let secPerMeasure = 4.0
    let usedModal = false

    // ── Pre-fetch score bytes (needed for Claude vision; fetch once, use in parallel) ─
    let scoreBytesForClaude: Uint8Array | null = null
    if (isVisualScore && scorePath) {
      const { data: sBlob } = await admin.storage.from('sheet-music').download(scorePath).catch(() => ({ data: null }))
      if (sBlob) scoreBytesForClaude = new Uint8Array(await sBlob.arrayBuffer())
    }

    // ── Path A: Modal audio + Claude score reading IN PARALLEL ────────────
    if (modalUrl && videoSignedUrl) {
      console.log('[analyze-performance] starting Modal + Claude score read in parallel')

      // Claude reads the visual score while Modal processes audio
      const scorePromise: Promise<ScoreReading> = scoreBytesForClaude
        ? readScoreNotes(scoreBytesForClaude, scoreMimeType, safeStart, instrument ?? 'instrument', tSig)
            .catch(err => {
              console.error('[analyze-performance] readScoreNotes threw:', (err as Error).message)
              return { key_signature: null, time_signature: null, tempo_marking: null, measures: [] } as ScoreReading
            })
        : Promise.resolve({ key_signature: null, time_signature: null, tempo_marking: null, measures: [] })

      const modalPromise = callModalWorker(modalUrl, {
        video_url:     videoSignedUrl,
        score_url:     isXmlScore && scoreSignedUrl ? scoreSignedUrl : undefined,
        score_mime:    scoreMimeType ?? undefined,
        instrument:    instrument ?? 'instrument',
        start_measure: safeStart,
        time_sig:      tSig,
      }).catch(err => {
        console.error('[analyze-performance] Modal worker threw:', (err as Error).message)
        return null
      })

      const [workerResult, scoreResult] = await Promise.all([modalPromise, scorePromise])

      // Apply Claude score result (if Modal didn't parse score from music21)
      if (scoreResult.measures.length > 0) {
        score = scoreResult
        console.log('[analyze-performance] Claude score read:', score.measures.length, 'measures')
      }

      if (workerResult && !workerResult.error && workerResult.audio) {
        const wa = workerResult.audio
        const rawEvents: AudioEvent[] = wa.events.map(e => ({
          time_sec:     e.time_sec,
          pitches:      e.pitches,
          confidence:   e.confidence,
          loudness:     e.loudness ?? null,
          articulation: null,
        }))

        audio = {
          audio_duration_sec: wa.audio_duration_sec,
          events:             rawEvents,
          tempo_estimate_bpm: wa.tempo_estimate_bpm,
          tempo_steadiness:   wa.tempo_steadiness,
        }

        const beatTimes = wa.beat_times ?? []
        if (beatTimes.length > 0) {
          aligned = alignWithBeats(rawEvents, beatTimes, beatsPerMeasure, safeStart, safeEnd)
          if (beatTimes.length >= 2) {
            const avgBeatSec = (beatTimes[beatTimes.length - 1] - beatTimes[0]) / (beatTimes.length - 1)
            secPerMeasure = avgBeatSec * beatsPerMeasure
          }
          alignmentRanges = buildAlignmentRanges(aligned, secPerMeasure)
          console.log('[analyze-performance] Modal beat alignment: aligned', aligned.length, 'events, secPerMeasure', secPerMeasure.toFixed(2))
        }
        usedModal = true

        // Override with music21 score if Modal parsed one (XML upload path)
        if (workerResult.score && !workerResult.score.error && (workerResult.score.measures?.length ?? 0) > 0) {
          score = {
            key_signature:  workerResult.score.key_signature,
            time_signature: workerResult.score.time_signature,
            tempo_marking:  workerResult.score.tempo_marking,
            measures:       workerResult.score.measures,
          }
          console.log('[analyze-performance] Modal music21 score:', score.measures.length, 'measures')
        }
      } else {
        if (workerResult?.error) {
          console.error('[analyze-performance] Modal returned error:', workerResult.error)
        }
        console.log('[analyze-performance] Modal failed or timed out — falling back to Gemini')
      }
    }

    // ── Path B: Gemini audio (if Modal skipped or failed) ─────────────────
    if (!usedModal) {
      // Score reading already happened in parallel above (if applicable).
      // If score is still empty and we haven't read it yet (non-Modal path), read it now.
      if (score.measures.length === 0 && scoreBytesForClaude && isVisualScore) {
        try {
          score = await readScoreNotes(scoreBytesForClaude, scoreMimeType, safeStart, instrument ?? 'instrument', tSig)
          console.log('[analyze-performance] Claude score read (Gemini path):', score.measures.length, 'measures')
        } catch (err) {
          console.error('[analyze-performance] readScoreNotes threw:', (err as Error).message)
        }
      }

      const { data: videoBlob, error: vErr } = await admin.storage.from('recordings').download(videoPath)
      if (vErr || !videoBlob) throw new Error(`Video download failed: ${vErr?.message}`)
      const videoBytes = new Uint8Array(await videoBlob.arrayBuffer())

      console.log('[analyze-performance] uploading video to Gemini, bytes:', videoBytes.length)
      let videoFileUri: string
      try {
        videoFileUri = await uploadVideoToGemini(videoBytes, videoMimeType, googleApiKey)
      } catch (err) {
        throw new Error(`Video upload to Gemini failed: ${(err as Error).message}`)
      }
      console.log('[analyze-performance] video uploaded:', videoFileUri)

      audio = await transcribeAudio(videoFileUri, videoMimeType, instrument ?? 'instrument', googleApiKey)
        .catch(err => {
          console.error('[analyze-performance] transcribeAudio threw:', (err as Error).message)
          return { audio_duration_sec: 0, events: [], tempo_estimate_bpm: null, tempo_steadiness: null } as AudioTranscription
        })

      console.log('[analyze-performance] Gemini events:', audio.events.length, 'tempo:', audio.tempo_estimate_bpm)
    }

    console.log('[analyze-performance] score measures:', score.measures.length, '| audio events:', audio.events.length, '| tempo:', audio.tempo_estimate_bpm)

    // ── Skeleton synthesis when score is empty ─────────────────────────────
    if (score.measures.length === 0 && audio.events.length > 0) {
      console.warn('[analyze-performance] synthesizing score skeleton from audio duration')
      const bpm = audio.tempo_estimate_bpm ?? 60
      const synthSec = Math.max(1, Math.min(15, beatsPerMeasure * (60 / bpm)))
      const endMeasureGuess = safeEnd ?? (safeStart + Math.min(40, Math.ceil(audio.audio_duration_sec / synthSec)) - 1)
      const count = endMeasureGuess - safeStart + 1
      score = {
        ...score,
        measures: Array.from({ length: count }, (_, i) => ({ number: safeStart + i, notes: [] })),
      }
      console.log('[analyze-performance] synthesized', count, 'skeleton measures')
    }

    // ── Anchor & align (used when Modal beat alignment didn't run) ─────────
    if (aligned.length === 0 && audio.events.length > 0) {
      const result = anchorAndAlign(score, audio, safeStart)
      aligned         = result.aligned
      secPerMeasure   = result.secPerMeasure || secPerMeasure
      alignmentRanges = result.alignmentRanges
    }

    // Apply endMeasure cap: drop any aligned events beyond the specified last measure
    if (safeEnd !== null) {
      const before = aligned.length
      aligned         = aligned.filter(ev => ev.measure <= safeEnd!)
      alignmentRanges = alignmentRanges.filter(r => r.measure <= safeEnd!)
      if (aligned.length < before) {
        console.log(`[analyze-performance] endMeasure cap (${safeEnd}): dropped ${before - aligned.length} events beyond last measure`)
      }
    }

    console.log('[analyze-performance] aligned events:', aligned.length, 'sec/measure:', secPerMeasure.toFixed(2))
    console.log('[analyze-performance] measures with audio:', alignmentRanges.map(r => r.measure))

    // ── Step 4: compare & coach ────────────────────────────────────────────
    const flags = await compareAndCoach(
      score,
      aligned,
      alignmentRanges,
      { bpm: audio.tempo_estimate_bpm, steadiness: audio.tempo_steadiness },
      pieceTitle ?? 'this piece',
      composer   ?? 'the composer',
      instrument ?? 'musician',
    )
    console.log('[analyze-performance] coaching flags:', flags.map(f => `m.${f.measure} (${f.type})`))

    const baseScore = Math.max(50, Math.min(98, 95 - flags.length * 6))

    const { data: take, error: insertError } = await admin
      .from('takes')
      .insert({
        user_id:         user.id,
        piece_title:     pieceTitle ?? 'Untitled',
        piece_composer:  composer   ?? 'Unknown',
        instrument:      instrument ?? null,
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
