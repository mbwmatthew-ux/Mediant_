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
  startMeasure: number | null,
  measureIndex: string,
  measureRange: { first: number; last: number } | null,
): string {
  let measureLine: string
  if (measureRange) {
    measureLine = `The student plays measures ${measureRange.first}–${measureRange.last}. Every flagged measure number MUST be within ${measureRange.first}–${measureRange.last}. Never use a measure number outside this range, and never count starting from 1.`
  } else if (startMeasure !== null && totalMeasures !== null) {
    measureLine = `The student plays measures ${startMeasure}–${totalMeasures}. Use ${startMeasure} as your anchor — do not count from 1.`
  } else if (startMeasure !== null) {
    measureLine = `The recording starts at measure ${startMeasure}. Use this as your anchor — do not count from 1.`
  } else if (totalMeasures !== null) {
    measureLine = `The score has ${totalMeasures} measures total.`
  } else {
    measureLine = `Count measures carefully from the start using the time signature.`
  }

  const indexBlock = measureIndex
    ? `\nMEASURE INDEX — what is written in each visible measure (use this to match audio events to the correct measure number, do NOT count from the start):\n${measureIndex}\n\nWhen you hear an event in the recording, FIRST identify what musical content you heard (e.g. "descending arpeggio in eighth notes", "ascending scale to a high note"), THEN find the matching entry in the index above, THEN use that entry's measure number. Never report a measure number that is not in the index.\n`
    : ''

  return `You are an expert music teacher and professional ${instrument} player analyzing a student's practice recording of "${pieceTitle}" by ${composer}.
Time signature: ${timeSig}.
${measureLine}
${indexBlock}
Listen to the ENTIRE recording carefully. Your job is to identify ONLY issues you can clearly and specifically hear.

RULES:
- Quality over quantity: 0–4 flags. Returning an empty flags array is correct and expected when the performance is clean — DO NOT invent issues to fill space.
- If you are not at least 80% confident an issue is real AND that you have the correct measure number, do not include it.
- Before flagging, ask yourself: "Can I name the exact beat and note where this happened?" If not, drop the flag.
- Only flag measures the student actually plays. Do not invent or assume issues.
- Do not flag the same problem in multiple consecutive measures unless you can hear it distinctly recurring in each.
- Name the exact beat, note, or passage where the issue happens.
- Choose the type that matches the PRIMARY symptom you hear. Use this decision order:
  1. INTONATION → only if a pitch is clearly sharp or flat against the harmony (string/wind/voice; never piano).
  2. TIMING → only if a beat is measurably rushed or dragged relative to surrounding pulse.
  3. ARTICULATION → only if note length / attack / separation is wrong (staccato vs legato, missing accent, blurred ties).
  4. DYNAMICS → only if loudness shape is wrong relative to the phrase (peak in wrong place, no contrast).
  5. VOICING → only if one voice/string/hand dominates and muddies the texture.
- Do NOT label something "timing" just because it sounds off — pick the actual symptom. If two symptoms coexist, flag the more severe one and mention the other in raw_detail.
- For TIMING: name which beat rushes or drags.
- For DYNAMICS: name where the line peaks or falls relative to the phrase shape.
- For ARTICULATION: name which notes are too short/long or missing separation.
- For INTONATION: name sharp or flat, which register.
- For VOICING: name which voice/string is too loud and why it muddies the texture.

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
      "timestamp_end": <seconds into the video where this measure ends, at least 2s after start>,
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

// Per-measure entry returned by extractMeasureLayout.
interface LayoutMeasure {
  number: number
  bbox: [number, number, number, number]   // [y0, x0, y1, x1] in 0–1000 units
  content: string                            // one-sentence factual description
}
interface ScoreLayout {
  staff_angle: number
  measures: LayoutMeasure[]
}

// Single rich pre-pass: ask Gemini to map out every visible measure on the
// score — number, bbox, and a one-sentence factual description of what's
// written. This index is the foundation for both correct measure labeling
// (audio-to-content matching) and accurate highlight boxes (lookup, not guess).
async function extractMeasureLayout(
  scoreFileUri: string,
  scoreMimeType: string,
  apiKey: string,
): Promise<ScoreLayout> {
  const prompt = `You are a professional music engraver building a structured layout map of a sheet music photo. Look at every measure visible in this image and return a JSON object describing them all.

For staff_angle:
- Estimate the clockwise rotation of the horizontal staff lines in degrees.
- Positive = right side lower than left. Negative = right side higher. A level photo = 0. Clamp to [-15, 15].

For measures, walk the page in reading order (top system left → right, then next system left → right):
- number: the printed measure number when shown. When a measure is NOT printed, infer it from the nearest printed anchor and the time signature (each system adds measures consecutively). Never output 0; never reset to 1 mid-page.
- bbox: a 4-integer array [y_min, x_min, y_max, x_max] in 0–1000 units (0 = top-left of the image, 1000 = bottom-right). The box must cover the FULL staff height for this measure (from the top staff line to the bottom staff line at this horizontal position, including ledger lines for high/low notes) AND the horizontal span from the opening barline to the closing barline of this single measure. Do NOT span multiple measures in one box.
- content: ONE short factual sentence describing what is written in this measure — the dominant rhythm or note pattern, plus any dynamic, tempo, articulation, or expression marking. Examples: "Descending F# minor arpeggio in eighth notes, p marking." / "Half note then two staccato quarters, crescendo to f." / "Rising chromatic run, sixteenth notes, no dynamic change."

List every measure you can see. Be exhaustive — do not skip any.`

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
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            maxOutputTokens: 8192,
          },
        }),
      }
    )
    if (!res.ok) {
      console.error('[extractMeasureLayout] HTTP error:', res.status, await res.text())
      return { staff_angle: 0, measures: [] }
    }
    const data = await res.json()
    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text as string) ?? ''
    // Strip code fences if present, then extract outer JSON object.
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const objStart = stripped.indexOf('{')
    const objEnd   = stripped.lastIndexOf('}')
    if (objStart === -1 || objEnd === -1) {
      console.error('[extractMeasureLayout] no JSON object in response:', raw.slice(0, 300))
      return { staff_angle: 0, measures: [] }
    }
    let parsed: { staff_angle?: number; measures?: unknown[] }
    try { parsed = JSON.parse(stripped.slice(objStart, objEnd + 1)) }
    catch (e) {
      console.error('[extractMeasureLayout] parse error:', (e as Error).message, 'raw:', raw.slice(0, 300))
      return { staff_angle: 0, measures: [] }
    }
    const staff_angle = typeof parsed.staff_angle === 'number'
      ? Math.max(-15, Math.min(15, parsed.staff_angle))
      : 0
    const measures: LayoutMeasure[] = []
    for (const m of (parsed.measures ?? [])) {
      const obj = m as { number?: unknown; bbox?: unknown; content?: unknown }
      if (typeof obj.number !== 'number' || !Number.isFinite(obj.number)) continue
      if (!Array.isArray(obj.bbox) || obj.bbox.length !== 4) continue
      const [y0, x0, y1, x1] = (obj.bbox as number[]).map(v => Math.max(0, Math.min(1000, Math.round(v))))
      if (y1 <= y0 || x1 <= x0) continue
      const content = typeof obj.content === 'string' ? obj.content.trim() : ''
      measures.push({ number: Math.round(obj.number), bbox: [y0, x0, y1, x1], content })
    }
    return { staff_angle, measures }
  } catch {
    return { staff_angle: 0, measures: [] }
  }
}

// Narrow a whole-measure bbox to the specific note/beat referenced in the
// flag's raw_detail. Only called when the detail clearly points at a single
// spot in the measure. Returns the narrowed bbox or null (caller falls back
// to the whole-measure bbox).
async function refineToNote(
  measureBbox: [number, number, number, number],
  measureContent: string,
  rawDetail: string,
  scoreFileUri: string,
  scoreMimeType: string,
  apiKey: string,
): Promise<[number, number, number, number] | null> {
  const [y0, x0, y1, x1] = measureBbox
  const prompt = `Below is a sheet music image. Inside it, ONE measure is at bounding box [y_min=${y0}, x_min=${x0}, y_max=${y1}, x_max=${x1}] (0–1000 coordinate space, 0 = top-left).

That measure contains: ${measureContent}

A performance issue occurred in this measure. The student's actual mistake was:
"${rawDetail}"

Locate the SPECIFIC note(s) or beat inside this measure where the issue happened. Return a narrower bounding box covering only that note or beat — it must lie entirely inside the measure box above, and should be at most about 40% as wide as the measure.

Return ONLY JSON: {"bbox": [y_min, x_min, y_max, x_max]} with integers 0–1000. If you cannot pinpoint the spot inside this measure, return {"bbox": null}.`

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
              { text: prompt },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text as string) ?? ''
    const jsonMatch = raw.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) return null
    let parsed: { bbox?: unknown }
    try { parsed = JSON.parse(jsonMatch[0]) } catch { return null }
    if (!parsed.bbox || !Array.isArray(parsed.bbox) || parsed.bbox.length !== 4) return null
    const [ny0, nx0, ny1, nx1] = (parsed.bbox as number[]).map(v => Math.max(0, Math.min(1000, Math.round(v))))
    if (ny1 <= ny0 || nx1 <= nx0) return null
    // Reject if it escapes the parent measure box (with a small slack).
    const slack = 10
    if (ny0 < y0 - slack || nx0 < x0 - slack || ny1 > y1 + slack || nx1 > x1 + slack) return null
    return [ny0, nx0, ny1, nx1]
  } catch {
    return null
  }
}

// True when raw_detail mentions a specific note/beat worth zooming in on.
function isNoteLevelIssue(rawDetail: string): boolean {
  return /\bbeat\b|\bdownbeat\b|first note|last note|second note|third note|fourth note|high\s*[A-G][#b♯♭]?|low\s*[A-G][#b♯♭]?|\b[A-G][#b♯♭]?\d?\b/i.test(rawDetail)
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

    // Single rich pre-pass: build the measure layout (number → bbox → content).
    // 45 s timeout — this is heavier than the old per-pass calls.
    const timeout = <T>(p: Promise<T>, fallback: T) =>
      Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), 45_000))])

    const layout: ScoreLayout = (scoreFileUri && scoreGeminiMime)
      ? await timeout(
          extractMeasureLayout(scoreFileUri, scoreGeminiMime, googleApiKey),
          { staff_angle: 0, measures: [] } as ScoreLayout,
        )
      : { staff_angle: 0, measures: [] }

    const layoutMap = new Map<number, LayoutMeasure>()
    for (const m of layout.measures) layoutMap.set(m.number, m)

    const measureIndex = layout.measures
      .map(m => `${m.number} — ${m.content}`)
      .join('\n')
    const measureRange = layout.measures.length > 0
      ? { first: layout.measures[0].number, last: layout.measures[layout.measures.length - 1].number }
      : null
    console.log('[analyze-performance] layout:', layout.measures.length, 'measures, angle:', layout.staff_angle)
    console.log('[analyze-performance] measureIndex (first 500):', measureIndex.slice(0, 500))

    const smInt = startMeasure ? parseInt(startMeasure, 10) : null
    const prompt = buildGeminiPrompt(
      pieceTitle  ?? 'this piece',
      composer    ?? 'unknown composer',
      timeSig     ?? '4/4',
      instrument  ?? 'Piano',
      totalMeasures,
      smInt,
      measureIndex,
      measureRange,
    )

    const { score, flags: allRawFlags } = await analyzeWithGemini(
      videoFileUri, videoMimeType, prompt, googleApiKey, scoreFileUri, scoreGeminiMime,
    )
    console.log('[analyze-performance] raw flags:', JSON.stringify(allRawFlags))

    // Drop flags Gemini isn't confident about, AND drop any flag whose measure
    // isn't in the layout (means Gemini hallucinated a measure outside the page).
    const rawFlags = allRawFlags
      .filter(f => (f.confidence ?? 100) >= 80)
      .filter(f => layoutMap.size === 0 || layoutMap.has(f.measure))
    console.log('[analyze-performance] flags after filtering:', JSON.stringify(rawFlags))

    // Coaching text + bbox lookup (with optional note-level zoom) per flag.
    // If the layout pass failed, fall back to a per-flag bbox find using the
    // full image as the parent region so the user still gets highlights.
    const flags = await Promise.all(
      rawFlags.map(async (f) => {
        const measureEntry = layoutMap.get(f.measure)
        const measureBbox  = measureEntry?.bbox ?? null

        let bboxPromise: Promise<[number, number, number, number] | null>
        if (measureBbox && measureEntry && scoreFileUri && scoreGeminiMime && isNoteLevelIssue(f.raw_detail)) {
          bboxPromise = refineToNote(measureBbox, measureEntry.content, f.raw_detail, scoreFileUri, scoreGeminiMime, googleApiKey)
        } else if (!measureEntry && scoreFileUri && scoreGeminiMime) {
          // Fallback: layout missing this measure — locate it directly.
          bboxPromise = refineToNote(
            [0, 0, 1000, 1000],
            `measure ${f.measure} of the score`,
            `Locate measure ${f.measure}. ${f.raw_detail}`,
            scoreFileUri, scoreGeminiMime, googleApiKey,
          )
        } else {
          bboxPromise = Promise.resolve(null)
        }

        const [body, narrowed] = await Promise.all([
          generateCoachingText(f, pieceTitle ?? 'this piece', composer ?? 'the composer', instrument ?? 'musician'),
          bboxPromise,
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
          spot:            narrowed ?? measureBbox ?? null,
          spot_angle:      layout.staff_angle,
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
