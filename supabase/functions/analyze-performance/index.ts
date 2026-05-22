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
// Hard wall for Modal worker fetch. AbortController cancels the network
// request; withTimeout() guarantees Promise.all resolves even if the
// abort doesn't fire correctly in some Deno environments.
const MODAL_TIMEOUT_MS = 60_000
// Gemini eval (fallback path only).
const GEMINI_EVAL_TIMEOUT_MS = 75_000
// Hard cap on the Claude coaching call so it never hangs the handler.
const COACH_TIMEOUT_MS = 25_000
// Top-level handler deadline — must be well under Supabase/Cloudflare's
// hard 150s kill. All internal timeouts sum to well under this.
const GLOBAL_TIMEOUT_MS = 110_000

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ])
}

// ── Types ──────────────────────────────────────────────────────────────────

interface ScoreNote {
  pitch: string | null         // e.g. "D3", "F#4"; null when unreadable
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
  pitch_hz?: number | null     // raw Hz from CREPE (sub-semitone precision)
  cents_offset?: number | null // deviation from nearest semitone, -50..+50 ¢
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
  beat: number | null
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

interface AnalysisQuality {
  trust: 'high' | 'medium' | 'low'
  canProceed: boolean
  reasons: string[]
}

function controlledAnalysisUnavailable(message: string, reasons: string[], suggestions: string[]): Response {
  const analysisQuality: AnalysisQuality = { trust: 'low', canProceed: false, reasons }
  return new Response(JSON.stringify({
    error: message,
    code: 'ANALYSIS_TEMPORARILY_UNAVAILABLE',
    analysisQuality,
    suggestions,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

function improvementSuggestions(quality: AnalysisQuality): string[] {
  const suggestions: string[] = []
  for (const reason of quality.reasons) {
    if (reason.includes('transcription worker')) {
      suggestions.push('Verify that the Modal worker is deployed and that MODAL_WORKER_URL is set in Supabase secrets.')
    } else if (reason.includes('score could not be parsed')) {
      suggestions.push('Upload a clearer score image or, for highest trust, use MusicXML/MXL instead of a photo or PDF.')
    } else if (reason.includes('Too few audio events')) {
      suggestions.push('Use a shorter excerpt with a cleaner solo recording and reduce background noise.')
    } else if (reason.includes('aligned to score measures')) {
      suggestions.push('Trim the clip to one clear excerpt and make sure the uploaded score matches exactly what is being played.')
    } else if (reason.includes('aligned to a very small number of measures')) {
      suggestions.push('Record a slightly longer continuous passage so the system can anchor the timing across multiple measures.')
    } else if (reason.includes('Direct listening corroboration')) {
      suggestions.push('Check that the Gemini API key is valid and that the uploaded video can be processed successfully.')
    }
  }
  return [...new Set(suggestions)]
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

function beatsPerMeasureFromTimeSig(timeSig: string | null | undefined): number {
  const match = String(timeSig ?? '').trim().match(/^(\d+)\s*\/\s*(\d+)$/)
  if (!match) return 4

  const num = parseInt(match[1], 10)
  const denom = parseInt(match[2], 10)
  if (!Number.isFinite(num) || !Number.isFinite(denom) || num <= 0 || denom <= 0) return 4

  const isCompound = num % 3 === 0 && num / 3 >= 2 && denom >= 8
  return isCompound ? Math.max(1, Math.round(num / 3)) : num
}

function assessAnalysisQuality(
  score: ScoreReading,
  audio: AudioTranscription,
  aligned: AlignedEvent[],
  alignmentRanges: Array<{ measure: number; start: number; end: number }>,
  usedModal: boolean,
  geminiAssessment: GeminiAssessment | null,
): AnalysisQuality {
  const reasons: string[] = []
  const readableMeasures = score.measures.filter(m => m.notes.length > 0).length

  if (!usedModal) {
    reasons.push('The dedicated transcription worker was unavailable, so the analysis fell back to a lower-trust transcription path.')
  }
  if (readableMeasures < 2) {
    reasons.push('The score could not be parsed into enough readable measures.')
  }
  if (audio.events.length < 8) {
    reasons.push('Too few audio events were extracted from the recording.')
  }
  if (aligned.length < 8) {
    reasons.push('Too few note events could be aligned to score measures.')
  }
  if (alignmentRanges.length < 2) {
    reasons.push('The recording only aligned to a very small number of measures.')
  }
  if (!geminiAssessment) {
    reasons.push('Direct listening corroboration from Gemini was unavailable.')
  }

  if (reasons.length === 0) return { trust: 'high', canProceed: true, reasons }
  if (reasons.length <= 2 && usedModal && readableMeasures >= 2 && aligned.length >= 8) {
    return { trust: 'medium', canProceed: true, reasons }
  }
  return { trust: 'low', canProceed: false, reasons }
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

For each sounded note you CAN read:
- pitch: scientific pitch notation ("D3", "F#4", "Bb3"). Use null ONLY when you can see a note-head but cannot determine its pitch (e.g. smudged, covered by fingering).
- IMPORTANT: Do NOT include rests in the notes array. Do not infer rests from blank space. Rests are ignored in this version because false rest detection creates bad feedback.
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
        {"pitch": "F#3", "beat": 2.5, "duration_beats": 0.5, "articulation": null, "dynamic": null}
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
  const measures = (parsed.measures ?? [])
    .filter(m => Array.isArray(m?.notes))
    .map(m => ({
      ...m,
      notes: m.notes.filter(n => String(n?.pitch ?? '').toLowerCase() !== 'rest'),
    }))
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

// Streams video from a Supabase signed URL directly to Gemini's resumable
// upload endpoint, avoiding a large Uint8Array buffer in the edge function.
async function uploadVideoToGeminiFromUrl(
  signedUrl: string,
  mimeType: string,
  apiKey: string,
): Promise<string> {
  const videoRes = await fetch(signedUrl)
  if (!videoRes.ok) throw new Error(`Failed to fetch video from storage (${videoRes.status})`)
  const fileSize = parseInt(videoRes.headers.get('content-length') ?? '0', 10)

  const initHeaders: Record<string, string> = {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Goog-Upload-Protocol': 'resumable',
    'X-Goog-Upload-Command': 'start',
    'X-Goog-Upload-Header-Content-Type': mimeType,
  }
  if (fileSize > 0) initHeaders['X-Goog-Upload-Header-Content-Length'] = String(fileSize)

  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}&uploadType=resumable`,
    { method: 'POST', headers: initHeaders, body: JSON.stringify({ file: { displayName: 'practice-recording' } }) },
  )
  if (!initRes.ok) throw new Error(`Gemini resumable init failed: ${await initRes.text()}`)
  const uploadUrl = initRes.headers.get('x-goog-upload-url')
  if (!uploadUrl) throw new Error('Gemini did not return an upload URL')

  const uploadHeaders: Record<string, string> = {
    'X-Goog-Upload-Command': 'upload, finalize',
    'X-Goog-Upload-Offset': '0',
  }
  if (fileSize > 0) uploadHeaders['Content-Length'] = String(fileSize)

  const uploadRes = await fetch(uploadUrl, { method: 'POST', headers: uploadHeaders, body: videoRes.body })
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
    const mRaw = startMeasure + Math.floor(Math.max(0, ev.time_sec - tAnchor) / secPerMeasure)
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
  geminiAssessment: GeminiAssessment | null,
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
  const rangeMapForEvidence = new Map(alignmentRanges.map(r => [r.measure, r]))
  const beatsPerMeasure = beatsPerMeasureFromTimeSig(score.time_signature)

  const evidenceCandidates: string[] = []
  for (const m of playedMeasures) {
    const events = (eventsByMeasure.get(m.number) ?? []).slice().sort((a, b) => a.time_sec - b.time_sec)
    const range = rangeMapForEvidence.get(m.number)
    const mStart = range?.start ?? events[0]?.time_sec ?? 0
    const mDur = range ? Math.max(0.5, range.end - range.start) : 4
    const secPerBeat = mDur / Math.max(1, beatsPerMeasure)

    for (const e of events) {
      if (e.cents_offset == null || Math.abs(e.cents_offset) < 30 || e.confidence < 45) continue
      const beat = Math.max(1, Number(((e.time_sec - mStart) / secPerBeat + 1).toFixed(2)))
      evidenceCandidates.push(
        `intonation | measure ${m.number} beat ${beat} | ${e.pitches.join('/')} is ${e.cents_offset > 0 ? '+' : ''}${e.cents_offset}¢ at ${e.time_sec.toFixed(2)}s`,
      )
    }

    const gaps = events.slice(1).map((e, i) => e.time_sec - events[i].time_sec).filter(g => g > 0)
    if (gaps.length >= 4) {
      const sorted = [...gaps].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      gaps.forEach((gap, i) => {
        if (median > 0 && gap > median * 2.2 && gap > 0.8) {
          const beat = Math.max(1, Number(((events[i].time_sec - mStart) / secPerBeat + 1).toFixed(2)))
          evidenceCandidates.push(
            `timing | measure ${m.number} near beat ${beat} | ${gap.toFixed(2)}s gap after ${events[i].pitches.join('/')} at ${events[i].time_sec.toFixed(2)}s`,
          )
        }
      })
    }
  }

  const strongestEvidence = evidenceCandidates.slice(0, 8)
  const hasGeminiEvidence = geminiAssessment && (
    geminiAssessment.intonation_issues.length > 0 ||
    geminiAssessment.rhythm_issues.length > 0 ||
    geminiAssessment.technique_issues.length > 0
  )
  if (strongestEvidence.length === 0 && !hasGeminiEvidence) {
    console.warn('[compareAndCoach] no measurable evidence candidates and no Gemini observations; returning no flags')
    return []
  }

  const measureBlocks = playedMeasures.map(m => {
    const soundedNotes = m.notes.filter(n => String(n?.pitch ?? '').toLowerCase() !== 'rest')
    const written = soundedNotes.length === 0
      ? '(score notation not parsed — analyze event spacing for rhythm/timing issues)'
      : soundedNotes.map(n => {
          const pitchLabel = n.pitch === null ? '(unreadable notehead)' : n.pitch
          const parts = [`${pitchLabel} @ beat ${n.beat} (${n.duration_beats}b)`]
          if (n.articulation) parts.push(n.articulation)
          if (n.dynamic)      parts.push(n.dynamic)
          return parts.join(' ')
        }).join(', ')
    const mStart = rangeStartMap.get(m.number) ?? 0
    const heard = (eventsByMeasure.get(m.number) ?? [])
      .map(e => {
        const offsetSec = (e.time_sec - mStart).toFixed(2)
        // Append cents only when the deviation is musically meaningful (≥5¢)
        const centsStr = (e.cents_offset != null && Math.abs(e.cents_offset) >= 5)
          ? ` (${e.cents_offset > 0 ? '+' : ''}${e.cents_offset}¢)`
          : ''
        return `${e.pitches.join('/')}${centsStr} @ +${offsetSec}s${e.loudness ? ' [' + e.loudness + ']' : ''}`
      })
      .join(', ')
    return `Measure ${m.number}:\n  WRITTEN: ${written}\n  HEARD:   ${heard || '(no events)'}`
  }).join('\n\n')

  const validMeasuresList = Array.from(validMeasures).sort((a, b) => a - b)
  const geminiEvidence = buildGeminiAssessmentBlock(geminiAssessment)
  const crepeHasData = strongestEvidence.length > 0

  const prompt = `You are a master ${instrument} teacher giving feedback to a student on "${pieceTitle}" by ${composer}.

Below is a measure-by-measure record of what is WRITTEN in the score and what was HEARD in the student's recording. Use this data to identify issues. Audio transcription is imperfect — sparse "heard" lines mean some notes weren't transcribed, not that nothing was played.

IMPORTANT: In the WRITTEN column, "(unreadable notehead)" means the score had a note-head but its pitch could not be read. Do NOT assume silence. Do NOT comment on rests, missing rests, skipped notes, or playing during rests. Rest detection is intentionally disabled because false rest feedback is not acceptable.

${measureBlocks}

${crepeHasData ? `MEASURABLE ISSUE CANDIDATES (from pitch/timing analysis):
${strongestEvidence.map((e, i) => `${i + 1}. ${e}`).join('\n')}` : 'MEASURABLE ISSUE CANDIDATES: (pitch analysis did not produce specific candidates for this recording — rely on direct listening below)'}

Tempo: ${tempo.bpm ?? '?'} BPM, ${tempo.steadiness ?? '?'}.
Key: ${score.key_signature ?? '?'}. Time signature: ${score.time_signature ?? '?'}.
${geminiEvidence}

CENTS NOTATION: Numbers like "(+32¢)" or "(-18¢)" after a pitch mean the student's pitch deviated from the nearest semitone by that many cents. 100¢ = 1 semitone.
- ±5–15¢: imperceptible to most listeners
- ±15–30¢: noticeable, worth mentioning
- ±30–45¢: clearly out of tune, significant issue
- ±45–50¢: borderline between two semitones — may be a wrong note entirely

YOUR TASK:
Identify 1–4 issues. Order of preference:
1. **Direct listening observations** — The DIRECT LISTENING CROSS-CHECK above is your most reliable source. If it names a specific passage, timestamp, or issue type, use it as your primary evidence. Cite the timestamp from the Gemini block in your raw_detail (e.g. "0:08 — opening note flat, per direct listening").
2. **Specific intonation issue from CREPE** — if a pitch shows cents deviation ≥15¢, flag it. Deviation ≥30¢ is your top CREPE priority.
3. **Pitch mismatch** (written vs. heard note name differs). Cite it specifically.
4. **Rhythm/timing patterns** — uneven offsets in HEARD, long gaps, rushed beats.
5. **Tempo issues** (too slow/fast, wavering).

HARD RULES:
- Every "measure" field MUST be one of: [${validMeasuresList.join(', ')}].
- ${crepeHasData ? 'Prefer flags that correspond to MEASURABLE ISSUE CANDIDATES. You may also flag issues named in the direct listening block even if they lack a CREPE candidate.' : 'Since CREPE candidates are unavailable, base flags on the DIRECT LISTENING CROSS-CHECK. Every flag must cite a timestamp or observation from that block in raw_detail.'}
- If the recording sounds genuinely clean and you have NO basis for concern, return fewer or zero flags.
- Do NOT invent a flag just to avoid returning zero. Precision matters more than quantity.
- Do NOT flag rests, silence, missing notes, skipped measures, dropped notes, or "coverage gaps".
- For intonation flags, raw_detail MUST cite either a cents value from HEARD or a direct listening timestamp.
- For rhythm/timing flags, raw_detail MUST cite observed offsets, gaps, or a direct listening timestamp.
- "type" must be one of: intonation, timing, rhythm, articulation, dynamics, voicing.
- raw_detail should cite the evidence (which note/beat/measure and what's off).

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
  const allowedTypes = new Set(['intonation', 'timing', 'rhythm', 'articulation', 'dynamics', 'voicing'])
  const flags: CoachingFlag[] = []
  for (const f of (parsed.flags ?? [])) {
    if (typeof f.measure !== 'number' || !validMeasures.has(f.measure)) {
      console.warn('[compareAndCoach] dropping flag with invalid measure:', f.measure)
      continue
    }
    if ((f.confidence ?? 100) < 60) continue
    if (!f.type || !f.title || !f.raw_detail || !f.body) continue
    if (!allowedTypes.has(String(f.type))) continue
    // Require cents citation for intonation flags only when CREPE candidates existed.
    // When Gemini is the sole evidence source, timestamps are the citation format.
    if (crepeHasData && String(f.type) === 'intonation' && !/[+-]\d+¢/.test(String(f.raw_detail))) continue
    if (/(rest|silence|missing note|skipped measure|dropped note|coverage gap|no events)/i.test(String(f.raw_detail))) continue

    const range = rangeMap.get(f.measure)
    if (!range) {
      console.warn('[compareAndCoach] dropping flag without alignment range:', f.measure)
      continue
    }

    const beat = typeof f.beat === 'number' && Number.isFinite(f.beat) ? f.beat : null
    let timestampStart = range.start
    let timestampEnd = range.end
    if (beat != null && beatsPerMeasure > 0) {
      const measureDuration = Math.max(0.5, range.end - range.start)
      const secPerBeat = measureDuration / beatsPerMeasure
      const center = range.start + Math.max(0, beat - 1) * secPerBeat
      timestampStart = Math.max(range.start, center - 0.45)
      timestampEnd = Math.min(range.end, center + Math.max(1.0, secPerBeat * 1.25))
      if (timestampEnd <= timestampStart) timestampEnd = Math.min(range.end, timestampStart + 1.0)
    }

    flags.push({
      measure:         f.measure,
      beat,
      type:            String(f.type),
      title:           String(f.title),
      raw_detail:      String(f.raw_detail),
      body:            String(f.body),
      confidence:      f.confidence ?? 100,
      timestamp_start: timestampStart,
      timestamp_end:   timestampEnd,
      spot:            null,
      spot_angle:      0,
    })
  }
  return flags
    .sort((a, b) => b.confidence - a.confidence)
    .filter((flag, index, all) =>
      all.findIndex(other => other.measure === flag.measure && other.type === flag.type) === index)
    .slice(0, 4)
}

// ── Beat-level alignment (used when Modal worker returns beat_times) ─────────

function alignWithBeatGrid(
  events: AudioEvent[],
  beatTimes: number[],
  beatsPerMeasure: number,
  startMeasure: number,
  endMeasure: number | null,
): { aligned: AlignedEvent[]; secPerMeasure: number } {
  if (!events.length) return { aligned: [], secPerMeasure: 4 }
  const maxMeasure = endMeasure ?? Infinity

  let avgBeatSec = 1
  if (beatTimes.length >= 2) {
    avgBeatSec = (beatTimes[beatTimes.length - 1] - beatTimes[0]) / (beatTimes.length - 1)
  }
  const secPerMeasure = Math.max(1, Math.min(30, avgBeatSec * beatsPerMeasure))
  const anchorTime = events[0].time_sec

  const aligned: AlignedEvent[] = []
  for (const ev of events) {
    const measureOffset = Math.floor(Math.max(0, ev.time_sec - anchorTime) / secPerMeasure)
    const measure = startMeasure + measureOffset
    if (measure > maxMeasure) continue
    aligned.push({ ...ev, measure })
  }
  return { aligned, secPerMeasure }
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

// ── Gemini direct listening evaluation ───────────────────────────────────

interface GeminiAssessment {
  intonation_issues: string[]
  rhythm_issues: string[]
  technique_issues: string[]
  overall: string
}

function buildGeminiAssessmentBlock(assessment: GeminiAssessment | null): string {
  if (!assessment) return 'DIRECT LISTENING CROSS-CHECK: unavailable.'

  return [
    'DIRECT LISTENING CROSS-CHECK (Gemini listening to the actual recording):',
    `- Intonation: ${assessment.intonation_issues.length ? assessment.intonation_issues.join(' | ') : 'No clear intonation issues reported.'}`,
    `- Rhythm: ${assessment.rhythm_issues.length ? assessment.rhythm_issues.join(' | ') : 'No clear rhythm issues reported.'}`,
    `- Technique: ${assessment.technique_issues.length ? assessment.technique_issues.join(' | ') : 'No clear technique issues reported.'}`,
    `- Overall: ${assessment.overall || 'No overall note provided.'}`,
    'Treat this block as corroborating evidence. Prefer issues that are supported by BOTH the written/heard alignment and the direct listening observations.',
  ].join('\n')
}

async function evaluatePerformanceWithGemini(
  videoFileUri: string,
  videoMimeType: string,
  instrument: string,
  pieceTitle: string,
  composer: string,
  startMeasure: number,
  endMeasure: number | null,
  apiKey: string,
): Promise<GeminiAssessment | null> {
  const endInfo = endMeasure ? ` through measure ${endMeasure}` : ''
  const prompt = `You are an expert ${instrument} teacher. Listen carefully to this student recording of "${pieceTitle}" by ${composer}, starting at measure ${startMeasure}${endInfo}.

Listen to the ENTIRE recording from start to finish. Then give me concrete, specific observations — NOT vague generalities.

INTONATION: List every passage where the pitch sounds noticeably flat or sharp. Give a timestamp and say which direction. E.g. "0:08 — opening note sounds a quarter-step flat", "0:32 — upper notes consistently sharp throughout the phrase". If intonation sounds generally clean, say so explicitly.

RHYTHM: List any rushed or dragged passages, hesitations, uneven note-spacing, or beat instability. Give timestamps. E.g. "0:15 — slight rush into beat 3", "0:40 — long note is cut short, creating a gap". If rhythm sounds solid, say so.

TECHNIQUE: List bow/breath noise, tone quality issues, insecure shifts, unclear articulation. Give timestamps. If technique sounds clean, say so.

OVERALL: One sentence — the single most important thing for this student to work on in this excerpt.

RULES:
- Be direct. Vague feedback like "intonation could be better" is useless — name the specific note or passage and timestamp it.
- If something is genuinely clean, say so. Do NOT fabricate issues.
- Focus on the 1-3 most important issues, not every tiny imperfection.

Return JSON only:
{
  "intonation_issues": ["<timestamp>: <specific observation>"],
  "rhythm_issues": ["<timestamp>: <specific observation>"],
  "technique_issues": ["<timestamp>: <specific observation>"],
  "overall": "<one sentence>"
}`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { fileData: { mimeType: videoMimeType, fileUri: videoFileUri } },
          { text: prompt },
        ]}],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 4096 },
      }),
    },
  )
  if (!res.ok) {
    console.error('[evaluateWithGemini] HTTP error:', res.status)
    return null
  }
  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined
  if (!text) return null
  const parsed = extractJsonObject(text) as Partial<GeminiAssessment> | null
  if (!parsed) return null
  console.log('[evaluateWithGemini] assessment received. overall:', parsed.overall?.slice(0, 100))
  return {
    intonation_issues: parsed.intonation_issues ?? [],
    rhythm_issues:     parsed.rhythm_issues     ?? [],
    technique_issues:  parsed.technique_issues  ?? [],
    overall:           parsed.overall           ?? '',
  }
}

// ── Modal worker call ─────────────────────────────────────────────────────

interface ModalAudioResult {
  audio_duration_sec: number
  events: Array<AudioEvent & { measure?: number; end_sec?: number; midi?: number; pitch_hz?: number; cents_offset?: number; source?: string }>
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
  // Use a manual AbortController instead of AbortSignal.timeout() — the static
  // method has reliability issues in some Deno versions used by Supabase Edge.
  const ac = new AbortController()
  const tid = setTimeout(() => ac.abort(), MODAL_TIMEOUT_MS)
  try {
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    clearTimeout(tid)
    if (!res.ok) {
      const text = await res.text().catch(() => '(no body)')
      throw new Error(`Modal worker HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return res.json() as Promise<ModalWorkerResult>
  } catch (err) {
    clearTimeout(tid)
    throw err
  }
}

// ── Handler ───────────────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
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

    const tSig = (timeSig ?? '4/4').toString()
    let beatsPerMeasure = beatsPerMeasureFromTimeSig(tSig)

    // Determine score type
    const XML_MIMES = new Set(['application/vnd.recordare.musicxml+xml', 'application/vnd.recordare.musicxml', 'text/xml', 'application/xml'])
    const scorePathLower = String(scorePath ?? '').toLowerCase()
    const isXmlScore = scoreMimeType && (
      XML_MIMES.has(scoreMimeType) ||
      scorePathLower.endsWith('.xml') ||
      scorePathLower.endsWith('.musicxml') ||
      scorePathLower.endsWith('.mxl')
    )
    const isVisualScore = Boolean(scoreMimeType && VISUAL_SCORE_TYPES.has(scoreMimeType)) ||
      scorePathLower.endsWith('.pdf') ||
      scorePathLower.endsWith('.png') ||
      scorePathLower.endsWith('.jpg') ||
      scorePathLower.endsWith('.jpeg') ||
      scorePathLower.endsWith('.webp')

    const modalUrl = Deno.env.get('MODAL_WORKER_URL')
    const googleApiKey = Deno.env.get('GOOGLE_AI_API_KEY')!

    // Always generate a video signed URL (used for Gemini streaming upload and Modal)
    const { data: vSignedData } = await admin.storage.from('recordings')
      .createSignedUrl(videoPath, 3600)
    const videoSignedUrl: string | null = vSignedData?.signedUrl ?? null

    let scoreSignedUrl: string | null = null
    if (modalUrl && scorePath) {
      const { data: sSigned } = await admin.storage.from('sheet-music')
        .createSignedUrl(scorePath, 3600)
      scoreSignedUrl = sSigned?.signedUrl ?? null
    }
    const shouldPreferWorkerScore = Boolean(modalUrl && videoSignedUrl && scoreSignedUrl && (isXmlScore || isVisualScore))

    let score: ScoreReading = { key_signature: null, time_signature: null, tempo_marking: null, measures: [] }
    let audio: AudioTranscription = { audio_duration_sec: 0, events: [], tempo_estimate_bpm: null, tempo_steadiness: null }
    let aligned: AlignedEvent[] = []
    let alignmentRanges: Array<{ measure: number; start: number; end: number }> = []
    let secPerMeasure = 4.0
    let usedModal = false
    let geminiAssessment: GeminiAssessment | null = null

    // ── Fire Modal immediately — it only needs the signed URL ─────────────
    const modalPromise: Promise<ModalWorkerResult | null> = (modalUrl && videoSignedUrl)
      ? callModalWorker(modalUrl, {
          video_url:     videoSignedUrl,
          score_url:     (isXmlScore || isVisualScore) && scoreSignedUrl ? scoreSignedUrl : undefined,
          score_mime:    scoreMimeType ?? undefined,
          instrument:    instrument ?? 'instrument',
          start_measure: safeStart,
          time_sig:      tSig,
        }).catch(err => {
          console.error('[analyze-performance] Modal worker threw:', (err as Error).message)
          return null
        })
      : Promise.resolve(null)

    // ── Download score bytes only (score image is small; video is streamed) ─
    const [scoreBlobRes] = await Promise.all([
      isVisualScore && scorePath
        ? admin.storage.from('sheet-music').download(scorePath).catch(() => ({ data: null }))
        : Promise.resolve({ data: null }),
    ])
    const scoreBytesForClaude = scoreBlobRes.data
      ? new Uint8Array(await scoreBlobRes.data.arrayBuffer()) : null

    // ── Gemini direct eval — only fires when Modal is unavailable. ────────
    // Video is streamed from the signed URL to Gemini without buffering
    // it in the edge function's memory, avoiding OOM on large recordings.
    const runGeminiEval = !modalUrl || !videoSignedUrl
    const geminiUploadPromise: Promise<string | null> = (runGeminiEval && googleApiKey && videoSignedUrl)
      ? uploadVideoToGeminiFromUrl(videoSignedUrl, videoMimeType, googleApiKey)
          .catch(err => {
            console.error('[analyze-performance] Gemini upload failed:', (err as Error).message)
            return null
          })
      : Promise.resolve(null)

    const geminiEvalPromise: Promise<GeminiAssessment | null> = geminiUploadPromise.then(fileUri =>
      fileUri && googleApiKey
        ? evaluatePerformanceWithGemini(
            fileUri, videoMimeType,
            instrument ?? 'instrument',
            pieceTitle ?? 'this piece',
            composer ?? 'the composer',
            safeStart, safeEnd, googleApiKey,
          ).catch(err => {
            console.error('[analyze-performance] Gemini eval failed:', (err as Error).message)
            return null
          })
        : null
    )

    // ── Claude reads score only when the worker cannot attempt structured parsing.
    // If Modal has the score URL, let Audiveris/music21 try first; Claude becomes
    // a fallback only if OMR/structured parsing returns no usable measures.
    const scorePromise: Promise<ScoreReading> = (scoreBytesForClaude && isVisualScore && !shouldPreferWorkerScore)
      ? readScoreNotes(scoreBytesForClaude, scoreMimeType, safeStart, instrument ?? 'instrument', tSig)
          .catch(err => {
            console.error('[analyze-performance] readScoreNotes threw:', (err as Error).message)
            return { key_signature: null, time_signature: null, tempo_marking: null, measures: [] } as ScoreReading
          })
      : Promise.resolve({ key_signature: null, time_signature: null, tempo_marking: null, measures: [] })

    // ── Await all three parallel tasks ────────────────────────────────────
    // Gemini eval is capped at GEMINI_EVAL_TIMEOUT_MS so it never holds up
    // the response beyond the Supabase Edge 150s hard limit. If it finishes
    // in time its observations become the primary coaching signal; if it
    // times out, Modal + Claude still produce a full analysis.
    const [workerResult, scoreResult, geminiEval] = await Promise.all([
      withTimeout(modalPromise, MODAL_TIMEOUT_MS, null),
      scorePromise,
      withTimeout(geminiEvalPromise, GEMINI_EVAL_TIMEOUT_MS, null),
    ])
    geminiAssessment = geminiEval
    console.log('[analyze-performance] parallel done | Modal:', workerResult ? 'ok' : 'null',
      '| score measures:', scoreResult.measures.length,
      '| gemini eval:', geminiAssessment ? 'ok' : 'null')

    // Apply Claude score result
    if (scoreResult.measures.length > 0) {
      score = scoreResult
    }
    beatsPerMeasure = beatsPerMeasureFromTimeSig(score.time_signature ?? tSig)
    console.log('[analyze-performance] beats per measure:', beatsPerMeasure, '| time signature:', score.time_signature ?? tSig)

    // ── Path A: process Modal result ──────────────────────────────────────
    if (workerResult && !workerResult.error && workerResult.audio) {
      if (workerResult.score && !workerResult.score.error && (workerResult.score.measures?.length ?? 0) > 0) {
        score = {
          key_signature:  workerResult.score.key_signature,
          time_signature: workerResult.score.time_signature,
          tempo_marking:  workerResult.score.tempo_marking,
          measures:       workerResult.score.measures,
        }
        beatsPerMeasure = beatsPerMeasureFromTimeSig(score.time_signature ?? tSig)
        console.log('[analyze-performance] Modal score:', score.measures.length, 'measures, source:', workerResult.score.source)
        console.log('[analyze-performance] beats per measure from Modal score:', beatsPerMeasure, '| time signature:', score.time_signature ?? tSig)
      }

      const wa = workerResult.audio
      const rawEvents: AudioEvent[] = wa.events.map(e => ({
        time_sec:     e.time_sec,
        pitches:      e.pitches,
        confidence:   e.confidence,
        loudness:     e.loudness ?? null,
        articulation: null,
        pitch_hz:     e.pitch_hz     ?? null,
        cents_offset: e.cents_offset ?? null,
      }))

      audio = {
        audio_duration_sec: wa.audio_duration_sec,
        events:             rawEvents,
        tempo_estimate_bpm: wa.tempo_estimate_bpm,
        tempo_steadiness:   wa.tempo_steadiness,
      }

      const beatTimes = wa.beat_times ?? []
      if (rawEvents.length > 0) {
        // Prefer the worker's beat-precise measure assignments over re-computing in the Edge fn
        const workerAligned: AlignedEvent[] = wa.events
          .filter(e => typeof e.measure === 'number')
          .map(e => ({
            time_sec:     e.time_sec,
            pitches:      e.pitches,
            confidence:   e.confidence,
            loudness:     e.loudness ?? null,
            articulation: null as string | null,
            pitch_hz:     e.pitch_hz     ?? null,
            cents_offset: e.cents_offset ?? null,
            measure:      e.measure!,
          }))

        if (workerAligned.length > 0) {
          aligned = workerAligned
          const avgBeatSec = beatTimes.length >= 2
            ? (beatTimes[beatTimes.length - 1] - beatTimes[0]) / (beatTimes.length - 1)
            : 1
          secPerMeasure = Math.max(1, Math.min(30, avgBeatSec * beatsPerMeasure))
          alignmentRanges = buildAlignmentRanges(aligned, secPerMeasure)
          console.log('[analyze-performance] worker measure assignments:', aligned.length, 'events, secPerMeasure', secPerMeasure.toFixed(2))
        } else {
          const result = alignWithBeatGrid(rawEvents, beatTimes, beatsPerMeasure, safeStart, safeEnd)
          aligned = result.aligned
          secPerMeasure = result.secPerMeasure
          alignmentRanges = buildAlignmentRanges(aligned, secPerMeasure)
          console.log('[analyze-performance] fallback beat alignment:', aligned.length, 'events, secPerMeasure', secPerMeasure.toFixed(2))
        }
      }
      usedModal = true
    } else {
      if (workerResult?.error) console.error('[analyze-performance] Modal error:', workerResult.error)
      console.log('[analyze-performance] Modal unavailable')
      if (modalUrl && videoSignedUrl) {
        return controlledAnalysisUnavailable(
          'Analysis timed out before enough musical evidence could be measured.',
          ['The dedicated transcription worker did not finish before the safe request deadline.'],
          [
            'Try a shorter excerpt first, ideally 15-45 seconds.',
            'For score accuracy, upload MusicXML/MXL if you have it.',
            'If using a screenshot or photo, use a clean cropped score image instead of a full-screen screenshot.',
          ],
        )
      }
    }

    if (score.measures.length === 0 && scoreBytesForClaude && isVisualScore) {
      console.warn('[analyze-performance] structured score parsing unavailable — falling back to Claude visual score reading')
      score = await readScoreNotes(scoreBytesForClaude, scoreMimeType, safeStart, instrument ?? 'instrument', tSig)
        .catch(err => {
          console.error('[analyze-performance] Claude visual fallback threw:', (err as Error).message)
          return { key_signature: null, time_signature: null, tempo_marking: null, measures: [] } as ScoreReading
        })
      beatsPerMeasure = beatsPerMeasureFromTimeSig(score.time_signature ?? tSig)
      console.log('[analyze-performance] Claude visual fallback measures:', score.measures.length)
    }

    // ── Path B: Gemini transcription fallback ─────────────────────────────
    if (!usedModal) {
      let geminiFileUri = await geminiUploadPromise
      if (!geminiFileUri && googleApiKey && videoSignedUrl) {
        geminiFileUri = await uploadVideoToGeminiFromUrl(videoSignedUrl, videoMimeType, googleApiKey).catch((err: Error) => {
          console.error('[analyze-performance] Gemini fallback upload failed:', err.message)
          return null
        })
      }
      if (!geminiFileUri) throw new Error('Video upload to Gemini failed and Modal worker is unavailable')

      audio = await transcribeAudio(geminiFileUri, videoMimeType, instrument ?? 'instrument', googleApiKey)
        .catch(err => {
          console.error('[analyze-performance] transcribeAudio threw:', (err as Error).message)
          return { audio_duration_sec: 0, events: [], tempo_estimate_bpm: null, tempo_steadiness: null } as AudioTranscription
        })
      console.log('[analyze-performance] Gemini transcription:', audio.events.length, 'events, tempo:', audio.tempo_estimate_bpm)
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

    const analysisQuality = assessAnalysisQuality(
      score,
      audio,
      aligned,
      alignmentRanges,
      usedModal,
      geminiAssessment,
    )
    console.log('[analyze-performance] trust:', analysisQuality.trust, '| reasons:', analysisQuality.reasons)

    if (!analysisQuality.canProceed) {
      return new Response(JSON.stringify({
        error: 'Analysis confidence is too low for precise feedback.',
        code: 'LOW_TRUST_ANALYSIS',
        analysisQuality,
        suggestions: improvementSuggestions(analysisQuality),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    // ── Step 4: compare & coach ────────────────────────────────────────────
    const flags = await withTimeout(
      compareAndCoach(
        score,
        aligned,
        alignmentRanges,
        { bpm: audio.tempo_estimate_bpm, steadiness: audio.tempo_steadiness },
        pieceTitle ?? 'this piece',
        composer   ?? 'the composer',
        instrument ?? 'musician',
        geminiAssessment,
      ),
      COACH_TIMEOUT_MS,
      [],
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
        analysis_quality: analysisQuality,
        analysis_backend: usedModal ? 'modal+gemini+claude' : 'gemini+claude-fallback',
      })
      .select('id')
      .single()
    if (insertError) throw new Error(`DB insert failed: ${insertError.message}`)

    return new Response(JSON.stringify({
      takeId: take.id,
      score: baseScore,
      flags,
      analysisQuality,
      analysisBackend: usedModal ? 'modal+gemini+claude' : 'gemini+claude-fallback',
    }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    console.error('[analyze-performance] error:', (err as Error).message)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
}

serve((req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  const timeoutResponse = new Response(
    JSON.stringify({
      error: 'Analysis took too long. Please try a shorter excerpt.',
      code: 'GLOBAL_TIMEOUT',
      analysisQuality: { trust: 'low', canProceed: false, reasons: ['The analysis exceeded the maximum allowed time.'] },
      suggestions: ['Try submitting a shorter clip (under 60 seconds) or a simpler score.'],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } },
  )

  return Promise.race([
    handleRequest(req),
    new Promise<Response>(resolve => setTimeout(() => resolve(timeoutResponse), GLOBAL_TIMEOUT_MS)),
  ])
})
