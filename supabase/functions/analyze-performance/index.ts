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
  scoreDescription: string,
): string {
  let measureLine: string
  if (anchoredMeasures.length > 0) {
    const first = anchoredMeasures[0]
    const last  = anchoredMeasures[anchoredMeasures.length - 1]
    measureLine = `The sheet music image shows measures ${anchoredMeasures.join(', ')}. The recording covers exactly this range (${first}–${last}). You MUST use ONLY these printed measure numbers — never count or guess. Every flagged measure must appear in this list: [${anchoredMeasures.join(', ')}].`
  } else if (startMeasure !== null && totalMeasures !== null) {
    measureLine = `The student plays measures ${startMeasure}–${totalMeasures}. Use ${startMeasure} as your anchor — do not count from 1.`
  } else if (startMeasure !== null) {
    measureLine = `The recording starts at measure ${startMeasure}. Use this as your anchor — do not count from 1.`
  } else if (totalMeasures !== null) {
    measureLine = `The score has ${totalMeasures} measures total.`
  } else {
    measureLine = `Count measures carefully from the start using the time signature.`
  }

  const bboxJson = hasVisualScore
    ? `\n      "bbox": [<y_min>, <x_min>, <y_max>, <x_max>],`
    : ''
  const bboxField = hasVisualScore
    ? `- bbox: bounding box of the affected region as [y_min, x_min, y_max, x_max], values 0–1000. Cover exactly the problematic note(s) or passage — not the whole row.`
    : ''

  const scoreContext = scoreDescription
    ? `\nSCORE READING (what is written in the score):\n${scoreDescription}\n\nUse the score reading above as ground truth for what should be played. Compare it against what you actually hear.`
    : ''

  return `You are an expert music teacher and professional ${instrument} player analyzing a student's practice recording of "${pieceTitle}" by ${composer}.
Time signature: ${timeSig}.
${measureLine}
${hasVisualScore ? 'The sheet music image is shown first. Read every printed measure number carefully before listening. Use ONLY the printed numbers — never invent or estimate a measure number.' : ''}
${scoreContext}
Listen to the ENTIRE recording carefully. Your job is to identify ONLY issues you can clearly and specifically hear.

RULES:
- Quality over quantity: 1–4 flags. Fewer accurate flags are far better than invented ones.
- If you are not at least 70% confident an issue is real, do not include it.
- Only flag measures the student actually plays. Do not invent or assume issues.
- Name the exact beat, note, or passage where the issue happens.
- For TIMING: which beat rushes or drags.
- For DYNAMICS: where the line peaks or falls relative to the phrase shape.
- For ARTICULATION: which notes are too short/long or missing separation.
- For INTONATION: sharp or flat, which register.
- For VOICING: which voice/string is too loud and why it muddies the texture.
${bboxField}

For timestamps: listen to the recording and note the wall-clock time in the video (in seconds from 0:00) where each flagged measure begins and ends. A single measure at a typical tempo spans 2–5 seconds. timestamp_end must be at least 2 seconds after timestamp_start.

Return ONLY valid JSON, no markdown:
{
  "score": <integer 0–100>,
  "flags": [
    {
      "measure": <integer>,
      "type": "<timing|dynamics|voicing|articulation|intonation>",
      "confidence": <integer 70–100>,
      "title": "<6–10 word specific problem title>",
      "timestamp_start": <seconds into the video where this measure begins>,
      "timestamp_end": <seconds into the video where this measure ends, at least 2s after start>,${bboxJson}
      "raw_detail": "<3 sentences: what you heard · which beat/note · why it matters>"
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

const GEMINI_MODEL = 'gemini-2.5-pro'

async function geminiGenerate(parts: unknown[], apiKey: string, temperature = 0.1): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature },
      }),
    }
  )
  if (!res.ok) throw new Error(`Gemini generateContent failed: ${await res.text()}`)
  const data = await res.json()
  return data.candidates[0].content.parts[0].text as string
}

function buildParts(
  videoFileUri: string,
  videoMimeType: string,
  prompt: string,
  scoreFileUri?: string,
  scoreMimeType?: string,
): unknown[] {
  const parts: unknown[] = []
  if (scoreFileUri && scoreMimeType)
    parts.push({ fileData: { mimeType: scoreMimeType, fileUri: scoreFileUri } })
  parts.push({ fileData: { mimeType: videoMimeType, fileUri: videoFileUri } })
  parts.push({ text: prompt })
  return parts
}

async function analyzeWithGemini(
  videoFileUri: string,
  videoMimeType: string,
  prompt: string,
  apiKey: string,
  scoreFileUri?: string,
  scoreMimeType?: string,
) {
  const raw = await geminiGenerate(buildParts(videoFileUri, videoMimeType, prompt, scoreFileUri, scoreMimeType), apiKey, 0.1)
  // Strip markdown code fences if present, then extract the outermost JSON object
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const start = stripped.indexOf('{')
  const end   = stripped.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('Gemini did not return valid JSON in Pass 2')
  return JSON.parse(stripped.slice(start, end + 1)) as { score: number; flags: Array<{ measure: number; type: string; title: string; confidence?: number; raw_detail: string; timestamp_start?: number; timestamp_end?: number; bbox?: [number, number, number, number] }> }
}

const VISUAL_SCORE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])

// Pre-pass: ask Gemini to read the printed measure numbers off the score image.
// Returns them sorted ascending. Falls back to [] on any error.
async function extractMeasureNumbers(scoreFileUri: string, scoreMimeType: string, apiKey: string): Promise<number[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
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

// Pre-pass: detect the clockwise tilt angle of the staff lines in the score photo.
// Called once per submission; the same angle is applied to all flag highlights.
async function detectStaffAngle(scoreFileUri: string, scoreMimeType: string, apiKey: string): Promise<number> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { fileData: { mimeType: scoreMimeType, fileUri: scoreFileUri } },
              { text: 'Look at the horizontal staff lines in this sheet music photo. Estimate the clockwise rotation angle of the staff lines in degrees — positive means the right side is lower than the left, negative means the right side is higher. A perfectly level photo is 0. Most hand-held photos are between -10 and +10 degrees. Return ONLY a single number with up to one decimal place, e.g. 3.5 or -2.0. No other text.' },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      }
    )
    if (!res.ok) return 0
    const data = await res.json()
    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text as string ?? '').trim()
    const angle = parseFloat(raw)
    return isNaN(angle) ? 0 : Math.max(-15, Math.min(15, angle))
  } catch {
    return 0
  }
}

// Dedicated spot pass: locate the specific note/passage for a flag in the score image.
// staffAngle is detected separately; this call only returns the bbox.
async function refineSpot(
  measureNum: number,
  issueType: string,
  issueDetail: string,
  visibleMeasureCount: number,
  scoreFileUri: string,
  scoreMimeType: string,
  apiKey: string,
): Promise<[number, number, number, number] | null> {
  // Estimate maximum reasonable width for the issue in 0-1000 units.
  // visibleMeasureCount is how many measures fit across the full image width.
  const maxMeasureWidth = visibleMeasureCount > 0 ? Math.round(1000 / visibleMeasureCount) : 150
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { fileData: { mimeType: scoreMimeType, fileUri: scoreFileUri } },
              { text: `This is a sheet music image. Locate a specific performance issue and return a bounding box for it.

Measure: ${measureNum} — find its opening barline (the number "${measureNum}" is printed near it).
Issue type: ${issueType}
What happened: ${issueDetail}

Instructions:
1. Find measure ${measureNum}.
2. Identify exactly which note(s), beat(s), or passage the issue spans. This could be a single note, a group of notes, one full measure, or multiple consecutive measures.
3. Draw a bounding box covering only the affected region — not the whole staff row, not the whole line.
   - Height: from top staff line to bottom staff line at that location (include ledger lines if used).
   - Width: the actual horizontal extent of the affected note(s)/measure(s).
   - IMPORTANT: this image has approximately ${visibleMeasureCount} measures visible. One measure is therefore roughly ${maxMeasureWidth} units wide (out of 1000 total). A single-note issue should be much narrower than that. Do NOT return a box wider than the actual extent of the problem.
4. Return ONLY valid JSON with no other text:
{"bbox": [<y_min>, <x_min>, <y_max>, <x_max>]}
All values are integers 0–1000 (0 = top-left corner, 1000 = bottom-right corner).
If you cannot find measure ${measureNum} with confidence, return {"bbox": null}.` },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text as string) ?? ''
    // Robust JSON extraction — find the first {...} block regardless of field order
    const jsonMatch = raw.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) return null
    let parsed: { bbox?: unknown }
    try { parsed = JSON.parse(jsonMatch[0]) } catch { return null }
    if (!parsed.bbox || !Array.isArray(parsed.bbox) || parsed.bbox.length !== 4) return null
    const [y0, x0, y1, x1] = (parsed.bbox as number[]).map(v => Math.max(0, Math.min(1000, Math.round(v))))
    if (y1 <= y0 || x1 <= x0) return null
    return [y0, x0, y1, x1]
  } catch {
    return null
  }
}

// Pre-pass: Gemini reads the score image and describes what's written,
// producing ground-truth notation context used during performance analysis.
async function readScore(
  scoreFileUri: string,
  scoreMimeType: string,
  apiKey: string,
): Promise<string> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { fileData: { mimeType: scoreMimeType, fileUri: scoreFileUri } },
              { text: `You are a professional music engraver reading sheet music. Look at this score image carefully and produce a structured description of what is written — not what a student played, but what the score says.

For each measure visible, note:
- Measure number (as printed)
- Any tempo, dynamic, or expression markings (e.g. ff, p, cresc., rit.)
- Notable rhythmic patterns (dotted rhythms, syncopation, fast runs)
- Technical demands (large shifts, string crossings, wide intervals, high positions)
- Slurs, accents, or articulation markings

Also describe the overall: key signature, time signature, character/tempo marking, and the main technical challenges in this passage.

Write in plain prose. Be factual and specific — this will be used to assess a student's performance against what is written.` },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      }
    )
    if (!res.ok) return ''
    const data = await res.json()
    return (data.candidates?.[0]?.content?.parts?.[0]?.text as string ?? '').trim()
  } catch {
    return ''
  }
}

// ── Claude Sonnet coaching text ────────────────────────────────────────────

async function generateCoachingText(
  flag: { measure: number; type: string; title: string; raw_detail: string },
  pieceTitle: string,
  composer: string,
  instrument: string,
): Promise<string> {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 450,
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

    // Pre-passes: run all three score image analyses in parallel (30 s timeout each).
    const timeout = <T>(p: Promise<T>, fallback: T) =>
      Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), 30_000))])

    const [anchoredMeasures, staffAngle, scoreDescription] = await Promise.all([
      scoreFileUri && scoreGeminiMime
        ? timeout(extractMeasureNumbers(scoreFileUri, scoreGeminiMime, googleApiKey), [] as number[])
        : Promise.resolve([] as number[]),
      scoreFileUri && scoreGeminiMime
        ? timeout(detectStaffAngle(scoreFileUri, scoreGeminiMime, googleApiKey), 0)
        : Promise.resolve(0),
      scoreFileUri && scoreGeminiMime
        ? timeout(readScore(scoreFileUri, scoreGeminiMime, googleApiKey), '')
        : Promise.resolve(''),
    ])
    console.log('[analyze-performance] anchoredMeasures:', anchoredMeasures)
    console.log('[analyze-performance] staffAngle:', staffAngle)
    console.log('[analyze-performance] scoreDescription (first 300):', scoreDescription.slice(0, 300))

    const smInt = startMeasure ? parseInt(startMeasure, 10) : null
    const prompt = buildGeminiPrompt(
      pieceTitle  ?? 'this piece',
      composer    ?? 'unknown composer',
      timeSig     ?? '4/4',
      instrument  ?? 'Piano',
      totalMeasures,
      !!scoreFileUri,
      smInt,
      anchoredMeasures,
      scoreDescription,
    )

    const { score, flags: allRawFlags } = await analyzeWithGemini(
      videoFileUri, videoMimeType, prompt, googleApiKey, scoreFileUri, scoreGeminiMime,
    )
    console.log('[analyze-performance] raw flags:', JSON.stringify(allRawFlags))

    // Drop flags Gemini itself isn't confident about
    const rawFlags = allRawFlags.filter(f => (f.confidence ?? 100) >= 70)
    console.log('[analyze-performance] flags after confidence filter:', JSON.stringify(rawFlags))

    // Generate coaching text + refine spot in parallel for each flag
    const flags = await Promise.all(
      rawFlags.map(async (f) => {
        const [body, spotBbox] = await Promise.all([
          generateCoachingText(f, pieceTitle ?? 'this piece', composer ?? 'the composer', instrument ?? 'musician'),
          scoreFileUri && scoreGeminiMime
            ? refineSpot(f.measure, f.type, f.raw_detail, anchoredMeasures.length, scoreFileUri, scoreGeminiMime, googleApiKey)
            : Promise.resolve(null),
        ])
        // Validate timestamps — must be positive, ordered, and span at least 1.5 s
        const tsStart = f.timestamp_start ?? null
        const tsEnd   = f.timestamp_end   ?? null
        const validTs = tsStart !== null && tsEnd !== null
          && tsStart >= 0 && tsEnd > tsStart && (tsEnd - tsStart) >= 1.5
        return {
          measure:         f.measure,
          type:            f.type,
          title:           f.title,
          body,
          spot:            spotBbox ?? null,
          spot_angle:      staffAngle,
          timestamp_start: validTs ? tsStart : null,
          timestamp_end:   validTs ? tsEnd   : null,
        }
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
