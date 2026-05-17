import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Prompts ────────────────────────────────────────────────────────────────

function buildGeminiPrompt(
  pieceTitle: string,
  composer: string,
  timeSig: string,
  instrument: string,
  totalMeasures: number | null,
  hasVisualScore: boolean,
  startMeasure: number | null,
): string {
  let measureLine: string
  if (startMeasure !== null && totalMeasures !== null) {
    measureLine = `The student is playing measures ${startMeasure} through ${totalMeasures}. The recording starts at measure ${startMeasure} — use this as your anchor. All flagged measures must be within this range.`
  } else if (startMeasure !== null) {
    measureLine = `The recording starts at measure ${startMeasure}. Use this as your anchor point when counting measures — do not start from measure 1.`
  } else if (totalMeasures !== null) {
    measureLine = `The score has ${totalMeasures} measures. Identify each issue by its actual measure number.`
  } else {
    measureLine = `Count measures carefully from the start of the recording using the time signature.`
  }

  const bboxField = hasVisualScore
    ? `- bbox: bounding box of that measure in the sheet music image as [y_min, x_min, y_max, x_max] where each value is 0–1000 (0=top/left, 1000=bottom/right). The sheet music image has printed measure numbers — use them as ground truth.`
    : ''

  const bboxJson = hasVisualScore
    ? `\n      "bbox": [<y_min>, <x_min>, <y_max>, <x_max>],`
    : ''

  return `You are an expert music teacher analyzing a student's practice recording of "${pieceTitle}" by ${composer}.
Instrument: ${instrument}. Time signature: ${timeSig}.
${measureLine}
${hasVisualScore ? 'A sheet music image is provided. The printed measure numbers in the image are ground truth — cross-reference them with the audio to pinpoint exactly which measure each issue occurs in.' : ''}

Listen to the ENTIRE recording carefully and identify 2–4 specific, real performance issues you actually hear.

IMPORTANT: Only flag issues in measures the student actually plays in this recording. Do not flag measures they did not play.

For each issue provide:
- measure: the exact printed measure number (from the score) where the issue occurs
- type: one of: timing, dynamics, voicing, articulation, intonation
- title: a 6–10 word description of the specific issue
- raw_detail: 2–3 sentences describing what you heard and why it matters musically
${bboxField}

Return ONLY valid JSON — no markdown, no explanation:
{
  "score": <integer 0–100, overall performance quality>,
  "flags": [
    {
      "measure": <integer>,
      "type": "<timing|dynamics|voicing|articulation|intonation>",
      "title": "<short issue description>",${bboxJson}
      "raw_detail": "<technical detail for teacher>"
    }
  ]
}

Be specific and honest. Only report issues you genuinely detected. Return 2–4 flags maximum.`
}

// Parse total measure count from MusicXML text
function parseMeasureCount(xmlText: string): number | null {
  try {
    const matches = [...xmlText.matchAll(/<measure[^>]+number="(\d+)"/g)]
    const nums = matches.map(m => parseInt(m[1], 10)).filter(n => !isNaN(n))
    return nums.length > 0 ? Math.max(...nums) : null
  } catch {
    return null
  }
}

// ── Gemini Files API ───────────────────────────────────────────────────────

async function uploadVideoToGemini(videoBytes: Uint8Array, mimeType: string, apiKey: string): Promise<string> {
  const boundary = `gem_${Date.now()}`
  const metadata = JSON.stringify({ file: { displayName: 'practice-recording' } })
  const CRLF = '\r\n'

  const pre = `--${boundary}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${metadata}${CRLF}--${boundary}${CRLF}Content-Type: ${mimeType}${CRLF}${CRLF}`
  const post = `${CRLF}--${boundary}--`
  const preBytes  = new TextEncoder().encode(pre)
  const postBytes = new TextEncoder().encode(post)

  const body = new Uint8Array(preBytes.length + videoBytes.length + postBytes.length)
  body.set(preBytes)
  body.set(videoBytes, preBytes.length)
  body.set(postBytes, preBytes.length + videoBytes.length)

  const uploadRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}&uploadType=multipart`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: body,
    }
  )
  if (!uploadRes.ok) {
    const errText = await uploadRes.text()
    throw new Error(`Gemini upload failed: ${errText}`)
  }

  const { file } = await uploadRes.json()

  // Poll until ACTIVE (video processing can take a few seconds)
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

async function analyzeWithGemini(
  videoFileUri: string,
  videoMimeType: string,
  prompt: string,
  apiKey: string,
  scoreFileUri?: string,
  scoreMimeType?: string,
) {
  const parts: unknown[] = [{ fileData: { mimeType: videoMimeType, fileUri: videoFileUri } }]
  if (scoreFileUri && scoreMimeType) {
    parts.push({ fileData: { mimeType: scoreMimeType, fileUri: scoreFileUri } })
  }
  parts.push({ text: prompt })

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.3 },
      }),
    }
  )
  if (!res.ok) throw new Error(`Gemini generateContent failed: ${await res.text()}`)

  const data = await res.json()
  const raw = data.candidates[0].content.parts[0].text as string
  const json = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  return JSON.parse(json) as { score: number; flags: Array<{ measure: number; type: string; title: string; raw_detail: string; bbox?: [number, number, number, number] }> }
}

const VISUAL_SCORE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])

// ── Claude Haiku coaching text ─────────────────────────────────────────────

async function generateCoachingText(
  flag: { type: string; title: string; raw_detail: string },
  pieceTitle: string,
  composer: string,
): Promise<string> {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 280,
    messages: [{
      role: 'user',
      content: `You are a warm, encouraging music teacher. A student is working on "${pieceTitle}" by ${composer}.

The AI detected this issue: ${flag.raw_detail}

Write 2–3 sentences of specific, actionable coaching feedback. Sound like a human teacher — warm but direct. Give one concrete practice technique they can try right now.`,
    }],
  })
  return (msg.content[0] as { type: string; text: string }).text.trim()
}

// ── Handler ────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    // Auth
    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) throw new Error('Unauthorized')

    const { videoPath, videoMimeType, scorePath, scoreMimeType, pieceTitle, composer, timeSig, instrument, startMeasure } = await req.json()
    if (!videoPath || !videoMimeType) throw new Error('videoPath and videoMimeType are required')

    // Download video from Supabase Storage via service role
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: videoBlob, error: dlError } = await admin.storage
      .from('recordings')
      .download(videoPath)
    if (dlError || !videoBlob) throw new Error(`Video download failed: ${dlError?.message}`)

    const videoBytes = new Uint8Array(await videoBlob.arrayBuffer())
    const googleApiKey = Deno.env.get('GOOGLE_AI_API_KEY')!

    // Handle score file: image/PDF → upload to Gemini for visual analysis;
    // XML → parse measure count for text context
    let totalMeasures: number | null = null
    let scoreFileUri: string | undefined
    let scoreGeminiMime: string | undefined

    if (scorePath && scoreMimeType) {
      const { data: scoreBlob } = await admin.storage.from('sheet-music').download(scorePath)
      if (scoreBlob) {
        if (VISUAL_SCORE_TYPES.has(scoreMimeType)) {
          // Upload image/PDF to Gemini so it can visually see the sheet music
          const scoreBytes = new Uint8Array(await scoreBlob.arrayBuffer())
          scoreFileUri   = await uploadVideoToGemini(scoreBytes, scoreMimeType, googleApiKey)
          scoreGeminiMime = scoreMimeType
        } else {
          // Try to parse measure count from XML
          try {
            const xmlText = await scoreBlob.text()
            totalMeasures = parseMeasureCount(xmlText)
          } catch { /* not plain XML */ }
        }
      }
    }

    // Upload video to Gemini Files API
    const videoFileUri = await uploadVideoToGemini(videoBytes, videoMimeType, googleApiKey)

    // Analyze with Gemini (video + optional visual score)
    const prompt = buildGeminiPrompt(
      pieceTitle   ?? 'this piece',
      composer     ?? 'unknown composer',
      timeSig      ?? '4/4',
      instrument   ?? 'Piano',
      totalMeasures,
      !!scoreFileUri,
      startMeasure ? parseInt(startMeasure, 10) : null,
    )
    const { score, flags: rawFlags } = await analyzeWithGemini(
      videoFileUri, videoMimeType, prompt, googleApiKey, scoreFileUri, scoreGeminiMime,
    )

    // Generate warm coaching text for each flag via Claude Haiku
    const flags = await Promise.all(
      rawFlags.map(async (f) => {
        const body = await generateCoachingText(f, pieceTitle ?? 'this piece', composer ?? 'the composer')
        return { measure: f.measure, type: f.type, title: f.title, body, bbox: f.bbox ?? null }
      })
    )

    // Store results in takes table
    const { data: take, error: insertError } = await admin
      .from('takes')
      .insert({
        user_id:         user.id,
        piece_title:     pieceTitle  ?? 'Untitled',
        piece_composer:  composer    ?? 'Unknown',
        video_path:      videoPath,
        video_mime_type: videoMimeType,
        score_path:      scorePath ?? null,
        score:           Math.round(score),
        flags,
      })
      .select('id')
      .single()
    if (insertError) throw new Error(`DB insert failed: ${insertError.message}`)

    return new Response(JSON.stringify({ takeId: take.id, score: Math.round(score), flags }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
