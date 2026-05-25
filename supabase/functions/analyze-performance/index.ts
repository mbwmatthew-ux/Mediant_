import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Gemini video analysis via Files API ───────────────────────────────────────
// ── Tempo → seconds per measure ──────────────────────────────────────────────
function secsPerMeasure(timeSig: string, bpm: number): number | null {
  const m = timeSig.match(/^(\d+)\/(\d+)$/)
  if (!m || bpm <= 0) return null
  const num = parseInt(m[1])
  const den = parseInt(m[2])
  return (num / den) * 240 / bpm
}

async function runGeminiVideo(opts: {
  takeId:       string
  videoUrl:     string
  videoMimeType: string
  pieceTitle:   string
  composer:     string
  instrument:   string
  timeSig:      string
  keySignature: string
  safeStart:    number
  safeEnd:      number | null
  tempo:        number
}): Promise<{ score: number; flags: unknown[] }> {
  const apiKey = Deno.env.get('GOOGLE_AI_API_KEY')
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured')

  // Fetch video — read headers only, do NOT buffer the body (avoids OOM on large files)
  const videoRes = await fetch(opts.videoUrl)
  if (!videoRes.ok) throw new Error(`Video fetch failed: ${videoRes.status}`)
  const contentLength = videoRes.headers.get('content-length') ?? '0'
  console.log(`[gemini] streaming ${contentLength}b to Files API`)

  // Start Gemini Files API resumable upload
  const initResp = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol':              'resumable',
        'X-Goog-Upload-Command':               'start',
        'X-Goog-Upload-Header-Content-Length': contentLength,
        'X-Goog-Upload-Header-Content-Type':   opts.videoMimeType,
        'Content-Type':                         'application/json',
      },
      body: JSON.stringify({ file: { displayName: 'performance' } }),
    }
  )
  if (!initResp.ok) {
    const t = await initResp.text()
    throw new Error(`Files API init failed ${initResp.status}: ${t.slice(0, 400)}`)
  }
  const uploadUrl = initResp.headers.get('X-Goog-Upload-URL')
  if (!uploadUrl) throw new Error('No Gemini upload URL returned')

  // Stream video body directly to Gemini — never loaded into heap
  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset':  '0',
      'Content-Type':          opts.videoMimeType,
      'Content-Length':        contentLength,
    },
    body: videoRes.body,
  })
  if (!uploadResp.ok) {
    const t = await uploadResp.text()
    throw new Error(`File upload failed ${uploadResp.status}: ${t.slice(0, 200)}`)
  }
  const fileInfo = await uploadResp.json()
  const fileUri  = fileInfo.file?.uri
  const fileName = fileInfo.file?.name
  if (!fileUri) throw new Error('No fileUri from Gemini upload')

  // Wait until ACTIVE — max 24s (8 × 3s)
  let state = fileInfo.file?.state ?? 'PROCESSING'
  for (let i = 0; i < 8 && state === 'PROCESSING'; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`)
    state = (await s.json()).state ?? 'FAILED'
  }
  if (state !== 'ACTIVE') throw new Error(`File never became ACTIVE (state: ${state})`)

  const measureRange = opts.safeEnd
    ? `measures ${opts.safeStart}–${opts.safeEnd}`
    : `from measure ${opts.safeStart}`

  const prompt = `You are an expert music performance coach with conservatory-level training, analysing a student's video recording.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${opts.keySignature ? `Key: ${opts.keySignature}. ` : ''}Time signature: ${opts.timeSig}
Recording covers: ${measureRange}
${opts.tempo > 0 ? `Tempo: ${opts.tempo} BPM` : ''}

Watch the ENTIRE video from start to finish. Listen carefully and observe:
- Rhythmic accuracy: rushed or dragged beats, unsteady pulse, incorrect subdivisions
- Intonation: out-of-tune notes, especially in exposed passages, high positions, or awkward intervals
- Bow technique (strings): bow distribution, contact point, bow speed, excessive pressure, flying bow, frog/tip control
- Finger technique: late arrivals, slides, missed shifts, collapsed joints
- Articulation and phrasing: slurring errors, staccato uniformity, accent placement
- Dynamics: failing to execute marked crescendos/diminuendos, lack of tonal contrast
- Expression and musicality: metronomic playing, no phrase shaping, missed character
- Memory slips, hesitations, or structural errors

SCORING RULES:
- 95–100: Genuinely professional, near-flawless. Empty flags array is allowed.
- 85–94: Very strong with minor issues. Minimum 2 flags.
- 70–84: Solid but with clear problems. Minimum 3–4 flags.
- 55–69: Noticeable issues throughout. Minimum 4–5 flags.
- Below 55: Significant technical or musical problems. Minimum 5+ flags.
Every point deducted from 100 MUST correspond to a specific, timestamped flag.

Return ONLY valid JSON (no markdown fences):
{
  "score": <integer 0-100>,
  "flags": [
    {
      "measure": <integer — ABSOLUTE score measure number. The recording starts at measure ${opts.safeStart}${opts.safeEnd ? ` and ends at measure ${opts.safeEnd}` : ''}. Do NOT reset to 1 — always use the actual score measure number.>,
      "type": "timing"|"intonation"|"dynamics"|"technique"|"error",
      "confidence": <integer 70-100 — how certain you are about this flag>,
      "title": "<8 words max — name the specific issue precisely>",
      "detail": "<2-4 sentences: exactly what went wrong, the musical consequence, and a specific actionable fix>",
      "timestamp_start": <seconds from the start of the video when this issue begins>,
      "timestamp_end": <seconds from the start of the video when this issue ends>
    }
  ]
}

Be specific and musical — name exact notes, intervals, beats, or bow strokes. Avoid vague feedback like "work on this passage." Tell the student what to listen for and how to practise it.`

  // Use confirmed-available models (v1beta only — v1 doesn't have these models)
  const candidates = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
  ]
  let genData: any = null

  for (const model of candidates) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ fileData: { mimeType: opts.videoMimeType, fileUri } }, { text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        }),
      }
    )
    if (r.ok) { genData = await r.json(); console.log(`[gemini] success: ${model}`); break }
    const errTxt = await r.text()
    console.warn(`[gemini] ${model} → ${r.status}: ${errTxt.slice(0, 200)}`)
    // Only hard-stop on auth errors — try next model for 400/404/500
    if (r.status === 401 || r.status === 403) throw new Error(`Gemini auth error ${r.status}: ${errTxt.slice(0, 200)}`)
  }

  // Cleanup file (non-fatal)
  if (fileName) fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`, { method: 'DELETE' }).catch(() => {})

  if (!genData) throw new Error('No Gemini model available — check GOOGLE_AI_API_KEY has Gemini API access.')

  // Skip thinking parts (gemini-2.5 series may include thought:true parts)
  const parts: any[] = genData.candidates?.[0]?.content?.parts ?? []
  const textPart = parts.find((p: any) => !p.thought && typeof p.text === 'string' && p.text.trim())
  const rawText = textPart?.text ?? '{}'
  let parsed: any = {}
  try { parsed = JSON.parse(rawText) } catch {
    const m = rawText.match(/\{[\s\S]*\}/)
    if (m) try { parsed = JSON.parse(m[0]) } catch { /* empty */ }
  }

  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 70)))

  // Gemini sometimes returns a score with no flags — treat as parse failure
  const rawFlags = Array.isArray(parsed.flags) ? parsed.flags : []
  const spm = secsPerMeasure(opts.timeSig, opts.tempo)
  const maxMeasure = opts.safeEnd ?? opts.safeStart + 200
  const flags = rawFlags.map((f: any) => {
    const ts = Number(f.timestamp_start) || 0
    const declared = Math.round(Number(f.measure) || 0)
    let measure: number
    if (declared >= opts.safeStart && declared <= maxMeasure) {
      // Model returned a valid absolute measure — trust it
      measure = declared
    } else if (spm && spm > 0 && ts > 0) {
      // Declared measure out of range — fall back to timestamp
      measure = opts.safeStart + Math.floor(ts / spm)
    } else {
      measure = opts.safeStart
    }
    measure = Math.max(opts.safeStart, Math.min(maxMeasure, measure))
    return {
      measure,
      type:            String(f.type  || 'technique'),
      confidence:      Math.max(50, Math.min(100, Math.round(Number(f.confidence) || 85))),
      title:           String(f.title || 'Issue detected'),
      detail:          String(f.detail || ''),
      timestamp_start: ts,
      timestamp_end:   Number(f.timestamp_end) || 0,
    }
  })

  // If score < 90 and no flags, the video was probably too short/unclear for Gemini
  // but we still got a score — throw so the caller falls back to Claude coaching
  if (score < 90 && flags.length === 0) {
    throw new Error(`Gemini returned score ${score} with no flags — falling back to coaching`)
  }

  return { score, flags }
}

// ── Claude vision analysis (from browser-extracted video frames) ─────────────
async function runClaudeVision(opts: {
  frames:       { base64: string; timestamp: number }[]
  pieceTitle:   string
  composer:     string
  instrument:   string
  timeSig:      string
  keySignature: string
  safeStart:    number
  safeEnd:      number | null
  tempo:        number
}): Promise<{ score: number; flags: unknown[] }> {
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const anthropic = new Anthropic({ apiKey: anthropicKey })
  const measureRange = opts.safeEnd ? `measures ${opts.safeStart}–${opts.safeEnd}` : `from measure ${opts.safeStart}`
  const keyNote = opts.keySignature ? `Key: ${opts.keySignature}. ` : ''

  const content: Anthropic.MessageParam['content'] = []

  // Add each frame with its timestamp label
  for (const frame of opts.frames) {
    content.push({ type: 'text', text: `Frame at ${frame.timestamp.toFixed(1)}s:` })
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: frame.base64 },
    })
  }

  content.push({
    type: 'text',
    text: `You are an expert music performance coach with conservatory-level training. You are seeing ${opts.frames.length} frames extracted from a student's video recording at evenly spaced timestamps.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${keyNote}Time signature: ${opts.timeSig}
Passage: ${measureRange}
${opts.tempo > 0 ? `Tempo: ${opts.tempo} BPM` : ''}

Study each frame carefully. Assess visible technique:
- Bow arm (strings): bow placement relative to the bridge, bow speed, contact point, arm weight, elbow height, wrist flexibility
- Left hand: finger curvature, collapsed joints, thumb position, hand frame, shift preparation
- Instrument hold: chin rest contact, shoulder rest use, scroll height, body angle
- Body and posture: shoulder elevation, back hunching, head tilt, jaw tension
- Facial expression and overall tension
- Any visible preparation problems that could affect upcoming passages

Score the visible technique 0–100. Be honest and calibrated:
- 90+: consistently excellent visible technique throughout all frames
- 75–89: good technique with one or two minor visible issues
- 60–74: clear technique problems visible in multiple frames
- Below 60: significant, recurring technical problems

Return ONLY valid JSON (no markdown fences):
{
  "score": <integer 0-100>,
  "flags": [
    {
      "measure": <integer — ABSOLUTE score measure number. The recording starts at measure ${opts.safeStart}. Do NOT count from 1 — use the actual score measure number.>,
      "type": "technique"|"timing"|"dynamics"|"intonation"|"error",
      "confidence": <integer 70-100 — confidence based on frame clarity>,
      "title": "<8 words max — name the specific technique issue you see>",
      "detail": "<2-3 sentences: what exactly is visible at that timestamp, why it causes problems, and a specific exercise or fix>",
      "timestamp_start": <seconds of the frame where issue is most visible>,
      "timestamp_end": <timestamp_start + 2.5>
    }
  ]
}

Give 4–6 flags. Cite the frame timestamp and the specific body part. Avoid generic advice — be as specific as the frames allow.`,
  })

  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    messages:   [{ role: 'user', content }],
  })

  const raw = ((message.content[0] as { type: string; text: string }).text ?? '{}').trim()
  let parsed: any = {}
  try {
    const jsonStr = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch { /* empty */ }

  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 72)))
  const spm2 = secsPerMeasure(opts.timeSig, opts.tempo)
  const maxMeasure2 = opts.safeEnd ?? opts.safeStart + 200
  const flags = (Array.isArray(parsed.flags) ? parsed.flags : []).map((f: any) => {
    const ts = Number(f.timestamp_start) || 0
    const declared = Math.round(Number(f.measure) || 0)
    let measure: number
    if (declared >= opts.safeStart && declared <= maxMeasure2) {
      measure = declared
    } else if (spm2 && spm2 > 0 && ts > 0) {
      measure = opts.safeStart + Math.floor(ts / spm2)
    } else {
      measure = opts.safeStart
    }
    measure = Math.max(opts.safeStart, Math.min(maxMeasure2, measure))
    return {
      measure,
      type:            String(f.type  || 'technique'),
      confidence:      Math.max(50, Math.min(100, Math.round(Number(f.confidence) || 78))),
      title:           String(f.title || 'Technique issue'),
      detail:          String(f.detail || ''),
      timestamp_start: ts,
      timestamp_end:   Number(f.timestamp_end) || 0,
    }
  })

  return { score, flags }
}

// ── Claude coaching fallback (piece-aware, no video scoring) ─────────────────
async function runClaudeCoaching(opts: {
  scoreUrl:      string | null
  scoreMimeType: string | null
  pieceTitle:    string
  composer:      string
  instrument:    string
  timeSig:       string
  keySignature:  string
  safeStart:     number
  safeEnd:       number | null
}): Promise<{ flags: unknown[] }> {
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const anthropic = new Anthropic({ apiKey: anthropicKey })
  const measureRange = opts.safeEnd ? `measures ${opts.safeStart}–${opts.safeEnd}` : `from measure ${opts.safeStart}`
  const keyNote = opts.keySignature ? `Key: ${opts.keySignature}. ` : ''

  const userContent: Anthropic.MessageParam['content'] = []

  // Include score image if we have one
  if (opts.scoreUrl && opts.scoreMimeType?.startsWith('image/')) {
    try {
      const r = await fetch(opts.scoreUrl)
      if (r.ok) {
        const bytes = new Uint8Array(await r.arrayBuffer())
        const b64 = btoa(String.fromCharCode(...bytes))
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: opts.scoreMimeType as 'image/jpeg' | 'image/png' | 'image/webp', data: b64 },
        })
      }
    } catch { /* skip */ }
  }

  const hasImage = userContent.length > 0
  userContent.push({
    type: 'text',
    text: `You are an expert music performance coach with conservatory-level knowledge. A student just recorded themselves playing the following passage.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${keyNote}Time signature: ${opts.timeSig}
Passage: ${measureRange}
${hasImage ? '\nThe sheet music for this passage is shown above. Study it carefully before giving feedback.' : ''}

Identify the 4–6 most important technical and musical challenges a student would commonly encounter in THIS specific passage on THIS instrument. Base your flags on the actual notes, rhythms, and technical demands visible in the score${hasImage ? ' above' : ' (which you know from your training)'}. Do not give generic advice that could apply to any piece.

Return ONLY valid JSON (no markdown):
{
  "flags": [
    {
      "measure": <integer — ABSOLUTE score measure number, between ${opts.safeStart} and ${opts.safeEnd ?? opts.safeStart + 50}>,
      "type": "timing"|"intonation"|"dynamics"|"technique"|"error",
      "confidence": 72,
      "title": "<8 words max — name the precise issue in this measure>",
      "detail": "<3 sentences: describe the specific technical demand in this measure, why students struggle with it on this instrument, and a precise practice strategy — e.g. specific fingering, bowing pattern, rhythmic subdivision, or listening target>",
      "timestamp_start": 0,
      "timestamp_end": 0
    }
  ]
}

Examples of good specificity: "The leap from E♭5 to B4 in m.12 often goes sharp — listen for the half-step relationship and drop the elbow slightly on arrival." Not: "Work on intonation in the higher register."`,
  })

  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1200,
    messages:   [{ role: 'user', content: userContent }],
  })

  const raw = ((message.content[0] as { type: string; text: string }).text ?? '{}').trim()
  let parsed: any = {}
  try {
    const jsonStr = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    parsed = JSON.parse(jsonStr)
  } catch { /* empty */ }

  const maxMeasure3 = opts.safeEnd ?? opts.safeStart + 200
  const flags = (Array.isArray(parsed.flags) ? parsed.flags : []).map((f: any) => {
    const declared = Math.round(Number(f.measure) || 0)
    const measure = Math.max(opts.safeStart, Math.min(maxMeasure3,
      declared >= opts.safeStart ? declared : opts.safeStart
    ))
    return {
      measure,
      type:            String(f.type  || 'technique'),
      confidence:      Math.max(50, Math.min(100, Math.round(Number(f.confidence) || 72))),
      title:           String(f.title || 'Coaching note'),
      detail:          String(f.detail || ''),
      timestamp_start: 0,
      timestamp_end:   0,
    }
  })

  return { flags }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    const body = await req.json()
    const {
      videoPath, videoMimeType,
      scorePath, scoreMimeType,
      pieceTitle, composer,
      timeSig, instrument, keySignature,
      startMeasure, endMeasure,
      videoFrames,
      tempo,
    } = body

    if (!videoPath || !videoMimeType) {
      return new Response(JSON.stringify({ error: 'videoPath and videoMimeType are required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    const safeStart = Math.max(1, parseInt(String(startMeasure ?? 1), 10) || 1)
    const safeEnd: number | null = endMeasure
      ? Math.max(safeStart, parseInt(String(endMeasure), 10))
      : null

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Insert take row in processing state
    const { data: take, error: insertError } = await admin
      .from('takes')
      .insert({
        user_id:         user.id,
        piece_title:     pieceTitle  ?? 'Untitled',
        piece_composer:  composer    ?? 'Unknown',
        instrument:      instrument  ?? null,
        video_path:      videoPath,
        video_mime_type: videoMimeType,
        score_path:      scorePath   ?? null,
        score:           null,
        flags:           [],
        job_status:      'processing',
        job_started_at:  new Date().toISOString(),
      })
      .select('id')
      .single()

    if (insertError || !take) throw new Error(`DB insert failed: ${insertError?.message}`)
    const takeId = take.id

    // Signed URLs
    const { data: vSigned } = await admin.storage.from('recordings').createSignedUrl(videoPath, 7200)
    const videoSignedUrl = vSigned?.signedUrl ?? null

    let scoreSignedUrl: string | null = null
    if (scorePath) {
      const { data: sSigned } = await admin.storage.from('sheet-music').createSignedUrl(scorePath, 7200)
      scoreSignedUrl = sSigned?.signedUrl ?? null
    }

    // ── 1. Try Modal (full async video analysis) ──────────────────
    const modalUrl = Deno.env.get('MODAL_WORKER_URL')
    if (modalUrl) {
      const dispatchRes = await fetch(`${modalUrl}/analyze_async`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          take_id:           takeId,
          webhook_url:       `${Deno.env.get('SUPABASE_URL')}/functions/v1/analysis-webhook`,
          webhook_secret:    Deno.env.get('MODAL_WEBHOOK_SECRET'),
          video_url:         videoSignedUrl,
          video_mime_type:   videoMimeType,
          score_url:         scoreSignedUrl,
          score_mime_type:   scoreMimeType   ?? null,
          instrument:        instrument      ?? 'instrument',
          piece_title:       pieceTitle      ?? 'this piece',
          composer:          composer        ?? 'the composer',
          time_sig:          timeSig         ?? '4/4',
          key_signature:     keySignature    ?? '',
          start_measure:     safeStart,
          end_measure:       safeEnd,
          gemini_api_key:    Deno.env.get('GOOGLE_AI_API_KEY'),
          anthropic_api_key: Deno.env.get('ANTHROPIC_API_KEY'),
        }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => null)

      if (dispatchRes?.ok) {
        console.log('[analyze-performance] dispatched to Modal:', takeId)
        return new Response(JSON.stringify({ jobId: takeId, status: 'processing' }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        })
      }
      console.warn('[analyze-performance] Modal unavailable, running inline')
    }

    // ── 2. Inline analysis: vision → Gemini → coaching ───────────
    const sharedOpts = {
      pieceTitle:   pieceTitle   ?? 'Unknown Piece',
      composer:     composer     ?? 'Unknown',
      instrument:   instrument   ?? 'instrument',
      timeSig:      timeSig      ?? '4/4',
      keySignature: keySignature ?? '',
      safeStart,
      safeEnd,
      tempo:        Math.max(0, parseInt(String(tempo ?? 0), 10) || 0),
    }

    let score: number | null = null
    let flags: unknown[]     = []
    let backend              = 'claude-coaching'
    let quality: unknown     = { trust: 'low', reasons: ['Sheet music analysis only — no video score or timestamps available.'] }

    function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        ),
      ])
    }

    // Path A: Gemini full-video analysis (60s max — upload + ACTIVE wait + generation)
    if (videoSignedUrl) {
      try {
        const geminiResult = await withTimeout(
          runGeminiVideo({ takeId, videoUrl: videoSignedUrl, videoMimeType, ...sharedOpts }),
          60_000, 'Gemini'
        )
        score   = geminiResult.score
        flags   = geminiResult.flags
        backend = 'gemini-inline'
        quality = { trust: 'high', reasons: [] }
        console.log('[analyze-performance] Gemini inline done:', takeId, 'score:', score)
      } catch (geminiErr) {
        console.warn('[analyze-performance] Gemini failed:', (geminiErr as Error).message)
      }
    }

    // Path B: browser-extracted video frames → Claude vision (45s max)
    const frames = Array.isArray(videoFrames) && videoFrames.length > 0 ? videoFrames : null
    if (score === null && frames) {
      try {
        const visionResult = await withTimeout(
          runClaudeVision({ frames, ...sharedOpts }),
          45_000, 'Claude vision'
        )
        score   = visionResult.score
        flags   = visionResult.flags
        backend = 'claude-vision'
        quality = { trust: 'medium', reasons: ['Analyzed from your video — visual technique scored; intonation and precise timing assessed separately.'] }
        console.log('[analyze-performance] Claude vision done:', takeId, 'score:', score, 'flags:', flags.length)
      } catch (visionErr) {
        console.warn('[analyze-performance] Claude vision failed:', (visionErr as Error).message)
      }
    }

    // Path C: Claude coaching fallback (20s max)
    if (score === null) {
      try {
        const claudeResult = await withTimeout(
          runClaudeCoaching({ scoreUrl: scoreSignedUrl, scoreMimeType: scoreMimeType ?? null, ...sharedOpts }),
          20_000, 'Claude coaching'
        )
        flags = claudeResult.flags
      } catch (err) {
        console.error('[analyze-performance] Claude coaching failed:', (err as Error).message)
      }
    }

    await admin.from('takes').update({
      job_status:       'done',
      score,
      flags,
      analysis_quality: quality,
      analysis_backend: backend,
      job_error:        null,
    }).eq('id', takeId)

    // Return jobId — polling loop will see status=done on first check
    return new Response(JSON.stringify({ jobId: takeId, status: 'done' }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })

  } catch (err) {
    console.error('[analyze-performance] unhandled error:', (err as Error).message)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
