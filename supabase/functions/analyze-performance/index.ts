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

  // Download video
  const videoResp = await fetch(opts.videoUrl)
  if (!videoResp.ok) throw new Error(`Video download failed: ${videoResp.status}`)
  const videoBytes = new Uint8Array(await videoResp.arrayBuffer())

  // Upload to Gemini Files API (v1beta is the only version that has the Files API)
  const initResp = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol':              'resumable',
        'X-Goog-Upload-Command':               'start',
        'X-Goog-Upload-Header-Content-Length': videoBytes.length.toString(),
        'X-Goog-Upload-Header-Content-Type':   opts.videoMimeType,
        'Content-Type':                         'application/json',
      },
      body: JSON.stringify({ file: { displayName: 'performance' } }),
    }
  )
  if (!initResp.ok) {
    const t = await initResp.text()
    throw new Error(`Files API init failed ${initResp.status}: ${t.slice(0, 200)}`)
  }
  const uploadUrl = initResp.headers.get('X-Goog-Upload-URL')
  if (!uploadUrl) throw new Error('No Gemini upload URL')

  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset':  '0',
    },
    body: videoBytes,
  })
  if (!uploadResp.ok) throw new Error(`File upload failed: ${uploadResp.status}`)
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

  // Try models in order of preference — stop on first success
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-1.5-pro', 'gemini-1.5-flash']
  let genData: any = null

  for (const model of models) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ fileData: { mimeType: opts.videoMimeType, fileUri } }, { text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2048 },
        }),
      }
    )
    if (r.ok) { genData = await r.json(); break }
    const errTxt = await r.text()
    console.warn(`[gemini] model ${model} failed (${r.status}): ${errTxt.slice(0, 120)}`)
    if (r.status !== 404) throw new Error(`Gemini error ${r.status}: ${errTxt.slice(0, 200)}`)
    // 404 = model not found, try next
  }

  // Cleanup file (non-fatal)
  if (fileName) fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`, { method: 'DELETE' }).catch(() => {})

  if (!genData) throw new Error('No Gemini model available for this API key')

  const rawText = genData.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
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

    // ── 2. Inline: try Gemini video first, fall back to Claude ────
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
    let quality              = 'low'

    if (videoSignedUrl) {
      try {
        const geminiResult = await runGeminiVideo({ takeId, videoUrl: videoSignedUrl, videoMimeType, ...sharedOpts })
        score   = geminiResult.score
        flags   = geminiResult.flags
        backend = 'gemini-inline'
        quality = 'medium'
        console.log('[analyze-performance] Gemini inline done:', takeId, 'score:', score)
      } catch (geminiErr) {
        console.warn('[analyze-performance] Gemini failed, falling back to Claude:', (geminiErr as Error).message)
        try {
          const claudeResult = await runClaudeCoaching({ scoreUrl: scoreSignedUrl, scoreMimeType: scoreMimeType ?? null, ...sharedOpts })
          flags = claudeResult.flags
        } catch (claudeErr) {
          console.error('[analyze-performance] Claude also failed:', (claudeErr as Error).message)
        }
      }
    } else {
      // No video URL — Claude coaching only
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
