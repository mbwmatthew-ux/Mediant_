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
  anchoredMeasures: number[],
): string {
  let measureLine: string
  if (anchoredMeasures.length > 0) {
    const first = anchoredMeasures[0]
    const last  = anchoredMeasures[anchoredMeasures.length - 1]
    measureLine = `The sheet music image shows measures ${anchoredMeasures.join(', ')}. The recording covers this exact range (${first}–${last}). You MUST use only these printed numbers — never count or guess. Every flagged measure must appear in this list.`
  } else if (startMeasure !== null && totalMeasures !== null) {
    measureLine = `The student is playing measures ${startMeasure} through ${totalMeasures}. The recording starts at measure ${startMeasure} — use this as your anchor. All flagged measures must be within this range.`
  } else if (startMeasure !== null) {
    measureLine = `The recording starts at measure ${startMeasure}. Use this as your anchor — do not start counting from measure 1.`
  } else if (totalMeasures !== null) {
    measureLine = `The score has ${totalMeasures} measures total.`
  } else {
    measureLine = `Count measures carefully from the start of the recording using the time signature.`
  }

  const bboxField = hasVisualScore
    ? `- bbox: tight bounding box around ONLY the single flagged measure bar as [y_min, x_min, y_max, x_max] where each value is 0–1000 (0=top/left, 1000=bottom/right). The box must start at the barline opening the measure and end at the barline closing it — do not include adjacent measures, do not span an entire system row. A single measure typically spans 10–25% of the image width.`
    : ''

  const bboxJson = hasVisualScore
    ? `\n      "bbox": [<y_min>, <x_min>, <y_max>, <x_max>],`
    : ''

  return `You are an expert music teacher and professional ${instrument} player analyzing a student's practice recording of "${pieceTitle}" by ${composer}.
Time signature: ${timeSig}.
${measureLine}
${hasVisualScore ? 'The sheet music image is shown first. Read every printed measure number carefully before listening. Use ONLY those printed numbers — never invent or estimate a measure number.' : ''}

Listen to the ENTIRE recording carefully. Identify 2–4 specific, real performance issues you actually hear.

IMPORTANT RULES:
- Only flag measures the student actually plays in this recording. Do not invent issues.
- Be precise: name the exact beat, note, or passage within the measure where the issue happens.
- For TIMING issues: describe whether it rushes, drags, or loses pulse, and on which beat.
- For DYNAMICS issues: describe whether a phrase peaks too early/late, or a note is too loud/soft relative to its musical role.
- For ARTICULATION issues: describe which notes are too short, too long, or missing bow/tongue separation.
- For INTONATION issues: name whether the pitch is sharp or flat, and in which register or shift.
- For VOICING issues: describe which voice or string is overpowering the others and why it muddies the texture.

For each issue provide:
- measure: the exact printed measure number where the issue occurs
- type: one of: timing, dynamics, voicing, articulation, intonation
- title: 6–10 words naming the specific problem (e.g. "Bow rushes through dotted rhythm in m.217")
- raw_detail: 3 sentences — (1) exactly what you heard, (2) which beat/note it occurs on, (3) why it matters for this passage
${bboxField}

Return ONLY valid JSON — no markdown, no explanation:
{
  "score": <integer 0–100>,
  "flags": [
    {
      "measure": <integer>,
      "type": "<timing|dynamics|voicing|articulation|intonation>",
      "title": "<specific issue>",${bboxJson}
      "raw_detail": "<what you heard · which beat/note · why it matters>"
    }
  ]
}`
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
  // Score image first so Gemini anchors to the printed measure numbers before listening
  const parts: unknown[] = []
  if (scoreFileUri && scoreMimeType) {
    parts.push({ fileData: { mimeType: scoreMimeType, fileUri: scoreFileUri } })
  }
  parts.push({ fileData: { mimeType: videoMimeType, fileUri: videoFileUri } })
  parts.push({ text: prompt })

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.1 },
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

// Pre-pass: ask Gemini to read the printed measure numbers off the score image.
// Returns them sorted ascending. Falls back to [] on any error.
async function extractMeasureNumbers(scoreFileUri: string, scoreMimeType: string, apiKey: string): Promise<number[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { fileData: { mimeType: scoreMimeType, fileUri: scoreFileUri } },
              { text: 'Look at this sheet music image. Find every measure number that is printed at the start of a measure or system. List them all in ascending order. Return ONLY a JSON array of integers with no other text, e.g. [212, 213, 214, 215, 216, 217, 218, 219, 220]. If no numbers are visible return [].' },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      }
    )
    if (!res.ok) return []
    const data = await res.json()
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text as string ?? ''
    const match = raw.match(/\[[\d,\s]*\]/)
    if (!match) return []
    const nums = JSON.parse(match[0]) as number[]
    return nums.filter((n): n is number => typeof n === 'number' && !isNaN(n)).sort((a, b) => a - b)
  } catch {
    return []
  }
}

// ── Claude Haiku coaching text ─────────────────────────────────────────────

async function generateCoachingText(
  flag: { measure: number; type: string; title: string; raw_detail: string },
  pieceTitle: string,
  composer: string,
  instrument: string,
): Promise<string> {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 380,
    messages: [{
      role: 'user',
      content: `You are an expert ${instrument} teacher giving feedback to a student on "${pieceTitle}" by ${composer}.

Issue detected in measure ${flag.measure} (${flag.type}): ${flag.raw_detail}

Write exactly 3 sentences of coaching feedback. No headers, no labels, no "Feedback:" prefix, no markdown — start immediately with the first sentence:
1. Acknowledge specifically what happened and where (reference the measure and what went wrong).
2. Explain briefly why this matters musically in this passage.
3. Give one concrete, named practice technique specific to ${instrument} they can use right now — be precise (e.g. "slow-bow on just beats 2–3", "use a metronome at 60 bpm", "practice the shift in isolation without vibrato").

Be direct and specific. Do not be vague or generic. Sound like a master teacher, not a chatbot.`,
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

    // Pre-pass: read the printed measure numbers off the score image.
    // Capped at 10 s so a slow image never blocks the main analysis.
    const anchoredMeasures = scoreFileUri && scoreGeminiMime
      ? await Promise.race([
          extractMeasureNumbers(scoreFileUri, scoreGeminiMime, googleApiKey),
          new Promise<number[]>(resolve => setTimeout(() => resolve([]), 10_000)),
        ])
      : []

    // Analyze with Gemini (video + optional visual score)
    const prompt = buildGeminiPrompt(
      pieceTitle   ?? 'this piece',
      composer     ?? 'unknown composer',
      timeSig      ?? '4/4',
      instrument   ?? 'Piano',
      totalMeasures,
      !!scoreFileUri,
      startMeasure ? parseInt(startMeasure, 10) : null,
      anchoredMeasures,
    )
    const { score, flags: rawFlags } = await analyzeWithGemini(
      videoFileUri, videoMimeType, prompt, googleApiKey, scoreFileUri, scoreGeminiMime,
    )

    // Generate warm coaching text for each flag via Claude Haiku
    const flags = await Promise.all(
      rawFlags.map(async (f) => {
        const body = await generateCoachingText(f, pieceTitle ?? 'this piece', composer ?? 'the composer', instrument ?? 'instrument')
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
