import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Gemini video analysis via Files API ───────────────────────────────────────
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

  // Wait until ACTIVE
  let state = fileInfo.file?.state ?? 'PROCESSING'
  for (let i = 0; i < 20 && state === 'PROCESSING'; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`)
    state = (await s.json()).state ?? 'FAILED'
  }
  if (state !== 'ACTIVE') throw new Error(`File never became ACTIVE (state: ${state})`)

  const measureRange = opts.safeEnd
    ? `measures ${opts.safeStart}–${opts.safeEnd}`
    : `from measure ${opts.safeStart}`

  const prompt = `You are an expert music performance coach analysing a video recording of a student practicing.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${opts.keySignature ? `Key: ${opts.keySignature}. ` : ''}Time signature: ${opts.timeSig}
Recording covers: ${measureRange}

MEASURE NUMBERING: The video starts at measure ${opts.safeStart} of the score. Number your flags using the actual score measure numbers (${opts.safeStart}, ${opts.safeStart + 1}, ${opts.safeStart + 2}...), NOT starting from 1.

Watch the ENTIRE video. Listen and observe carefully for:
- Rhythmic accuracy and steadiness
- Intonation / pitch accuracy
- Bow technique, bow speed, bow pressure (for strings), or equivalent
- Articulation, dynamics, and musical expression
- Any hesitations, memory slips, or technique breakdowns

IMPORTANT: Every point deducted from 100 must be explained as a flag. A score of 70 means 30 points of issues — you must list them. Only return an empty flags array if the performance is genuinely flawless (score 95+).

Return ONLY valid JSON (no markdown fences):
{
  "score": <integer 0-100, where 100 = flawless professional performance>,
  "flags": [
    {
      "measure": <integer — score measure number starting from ${opts.safeStart}>,
      "type": "timing"|"intonation"|"dynamics"|"technique"|"error",
      "title": "<8 words max — name the specific issue>",
      "detail": "<2-3 sentences: what went wrong, why it matters, how to fix it>",
      "timestamp_start": <video time in seconds when issue begins>,
      "timestamp_end": <video time in seconds when issue ends>
    }
  ]
}

List every meaningful issue you observe, minimum 3 flags for any score below 90.`

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
  const flags = rawFlags.map((f: any) => ({
    measure:         Number(f.measure)         || opts.safeStart,
    type:            String(f.type             || 'technique'),
    title:           String(f.title            || 'Issue detected'),
    detail:          String(f.detail           || ''),
    timestamp_start: Number(f.timestamp_start) || 0,
    timestamp_end:   Number(f.timestamp_end)   || 0,
  }))

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
    text: `You are an expert music performance coach. You are seeing ${opts.frames.length} frames extracted from a student's video recording.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${keyNote}Time signature: ${opts.timeSig}
Passage: ${measureRange}

Analyze what is VISIBLE in the frames. Look carefully for:
- Bow/arm/wrist technique (strings): bow placement, bow speed, bow pressure, arm weight, wrist flexibility
- Hand position and finger placement: collapsed knuckles, locked joints, incorrect finger curvature, thumb position
- Instrument hold and body posture: shoulder tension, hunching, head position
- Any visible signs of tension, discomfort, or technical breakdown
- Posture and relaxation of the whole body

Score the performance 0–100 based on visible technique quality. 90+ = excellent visible technique, 70–89 = solid with minor issues, below 70 = clear technique problems visible.

Return ONLY valid JSON (no markdown fences):
{
  "score": <integer 0-100>,
  "flags": [
    {
      "measure": <integer — estimated score measure number starting from ${opts.safeStart}>,
      "type": "timing"|"intonation"|"dynamics"|"technique"|"error",
      "title": "<8 words max — name the specific issue you observed>",
      "detail": "<2-3 sentences: what you see in the frame, why it matters, how to fix it>",
      "timestamp_start": <seconds — timestamp of the frame where issue is visible>,
      "timestamp_end": <timestamp_start + 2.5>
    }
  ]
}

Give 4–6 flags based on what you observe. Be specific about what is visible in the frames — name the exact frame timestamp, what body part, what the problem looks like.`,
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
  const flags = (Array.isArray(parsed.flags) ? parsed.flags : []).map((f: any) => ({
    measure:         Number(f.measure)         || opts.safeStart,
    type:            String(f.type             || 'technique'),
    title:           String(f.title            || 'Technique issue'),
    detail:          String(f.detail           || ''),
    timestamp_start: Number(f.timestamp_start) || 0,
    timestamp_end:   Number(f.timestamp_end)   || 0,
  }))

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
    text: `You are an expert music performance coach. A student just recorded themselves playing the following passage.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${keyNote}Time signature: ${opts.timeSig}
Passage: ${measureRange}
${hasImage ? '\nThe sheet music for this passage is shown above.' : ''}

Give specific, technical coaching notes for this exact passage on this instrument. Focus on the real challenges a student would face in measures ${opts.safeStart}${opts.safeEnd ? `–${opts.safeEnd}` : '+'}.

Return ONLY valid JSON (no markdown):
{
  "flags": [
    {
      "measure": <integer — the specific measure this applies to>,
      "type": "timing"|"intonation"|"dynamics"|"technique"|"error",
      "title": "<8 words max — specific to this passage>",
      "detail": "<2-3 sentences of actionable coaching specific to this piece, instrument, and measure>",
      "timestamp_start": 0,
      "timestamp_end": 0
    }
  ]
}

Give 4–6 flags. Be very specific: name exact notes, intervals, fingerings, bowings, or rhythmic patterns in this passage. Do not give generic advice.`,
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

  const flags = (Array.isArray(parsed.flags) ? parsed.flags : []).map((f: any) => ({
    measure:         Number(f.measure)         || opts.safeStart,
    type:            String(f.type             || 'technique'),
    title:           String(f.title            || 'Coaching note'),
    detail:          String(f.detail           || ''),
    timestamp_start: 0,
    timestamp_end:   0,
  }))

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

    // Rate limit: 10 analyses per 24h on free plan
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count: todayCount } = await admin
      .from('takes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', since)
    if ((todayCount ?? 0) >= 10) {
      return new Response(JSON.stringify({
        error: 'Daily limit reached — you\'ve run 10 analyses in the last 24 hours. Upgrade to Pro for unlimited analyses.',
      }), { status: 429, headers: { 'Content-Type': 'application/json', ...CORS } })
    }

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
    }

    let score: number | null = null
    let flags: unknown[]     = []
    let backend              = 'claude-coaching'
    let quality: unknown     = { trust: 'low', reasons: ['Sheet music analysis only — no video score or timestamps available.'] }

    // Path A: browser-extracted video frames → Claude vision (preferred, no memory limits)
    const frames = Array.isArray(videoFrames) && videoFrames.length > 0 ? videoFrames : null
    if (frames) {
      try {
        const visionResult = await runClaudeVision({ frames, ...sharedOpts })
        score   = visionResult.score
        flags   = visionResult.flags
        backend = 'claude-vision'
        quality = { trust: 'medium', reasons: ['Analyzed from your video — visual technique scored; intonation and precise timing assessed separately.'] }
        console.log('[analyze-performance] Claude vision done:', takeId, 'score:', score, 'flags:', flags.length)
      } catch (visionErr) {
        console.warn('[analyze-performance] Claude vision failed:', (visionErr as Error).message)
      }
    }

    // Path B: Gemini full-video analysis (if vision didn't succeed and we have a signed URL)
    if (score === null && videoSignedUrl) {
      try {
        const geminiResult = await runGeminiVideo({ takeId, videoUrl: videoSignedUrl, videoMimeType, ...sharedOpts })
        score   = geminiResult.score
        flags   = geminiResult.flags
        backend = 'gemini-inline'
        quality = { trust: 'medium', reasons: ['Full video analyzed — timestamps are approximate.'] }
        console.log('[analyze-performance] Gemini inline done:', takeId, 'score:', score)
      } catch (geminiErr) {
        console.warn('[analyze-performance] Gemini failed:', (geminiErr as Error).message)
      }
    }

    // Path C: Claude coaching fallback (sheet music only, no score)
    if (score === null) {
      try {
        const claudeResult = await runClaudeCoaching({ scoreUrl: scoreSignedUrl, scoreMimeType: scoreMimeType ?? null, ...sharedOpts })
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
