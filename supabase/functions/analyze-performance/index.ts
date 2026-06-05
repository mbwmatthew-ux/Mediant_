import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'
import { corsHeaders } from '../_shared/cors.ts'

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

  // Wait until ACTIVE — max 45s (15 × 3s)
  let state = fileInfo.file?.state ?? 'PROCESSING'
  for (let i = 0; i < 15 && state === 'PROCESSING'; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const s = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`)
    state = (await s.json()).state ?? 'FAILED'
  }
  if (state !== 'ACTIVE') throw new Error(`File never became ACTIVE (state: ${state})`)

  const measureRange = opts.safeEnd
    ? `measures ${opts.safeStart}–${opts.safeEnd}`
    : `from measure ${opts.safeStart}`

  const instrumentFamily = (() => {
    const i = opts.instrument.toLowerCase()
    if (/clarinet|flute|oboe|bassoon|saxophone/.test(i)) return 'woodwind'
    if (/trumpet|trombone|french horn|tuba|horn/.test(i)) return 'brass'
    if (/violin|viola|cello|double bass|bass/.test(i)) return 'strings'
    if (/piano|keyboard/.test(i)) return 'piano'
    if (/voice|soprano|alto|tenor|bass/.test(i)) return 'voice'
    return 'other'
  })()

  const instrumentSpecific = {
    woodwind: `For woodwind (${opts.instrument}): you MUST listen for squeaks, cracks, and tone breaks — these are automatic flags. Also flag: over-blowing causing pitch to go sharp, weak or breathy tone from insufficient air support, tongue placement causing smeared articulation, and octave key or register issues causing the wrong harmonic.`,
    brass: `For brass (${opts.instrument}): flag missed lip slurs, clipped or smeared valve attacks, notes that don't speak cleanly, intonation issues in the upper register (brass plays sharp when overblown), and poor breath support causing notes to fall flat or cut out.`,
    strings: `For strings (${opts.instrument}): flag bow scratches, arm-weight bow strokes that cause tone to crack, string crossings that clip adjacent strings, shifts that arrive late or out of tune, open string intonation issues, and flying or bouncing bow that breaks the line.`,
    piano: `For piano: flag wrong notes (name the pitch heard vs. expected), notes that don't speak (missed key), pedaling that creates muddiness by overlapping harmonically incompatible notes, and uneven voicing where the melody line disappears into the accompaniment.`,
    voice: `For voice: flag pitchy passages (name the direction — sharp or flat), vibrato that is too wide or unstable, vowel modifications that change the pitch, and breath support failures that cause the tone to spread or go flat at phrase ends.`,
    other: `Flag any audible error: wrong notes, tone issues, intonation drift, and rhythmic problems.`,
  }[instrumentFamily]

  const prompt = `AUDIO ANALYSIS TASK. You are analyzing the AUDIO TRACK of a student's performance video. Your primary job is to LISTEN and report what you HEAR — not what you see. Treat this as an ear-training exercise. Ignore the visual content unless it explains an audible problem.

You are a brutally honest but constructive music performance coach with conservatory-level ear training. Your job is to identify EVERY audible problem — do not be polite by omitting things you hear.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${opts.keySignature ? `Key: ${opts.keySignature}. ` : ''}Time signature: ${opts.timeSig}
Recording covers: ${measureRange}
${opts.tempo > 0 ? `Reference tempo: ${opts.tempo} BPM` : ''}

${instrumentSpecific}

MANDATORY DETECTION — you MUST flag these if you detect them, no exceptions:
1. WRONG NOTES: Any pitch that clearly does not belong to the passage. Name the note heard and what was expected.
2. SQUEAKS / TONE BREAKS: Any unintended squeak, crack, pop, or tone failure. These are always flagged.
3. RUSHING: If the performer plays ahead of the beat consistently over 3+ measures, flag as a timing issue covering that range.
4. DRAGGING: If the performer falls behind the beat consistently, flag as a timing issue covering that range.
5. INTONATION: Any passage (even 1 note) where pitch is audibly sharp or flat. Name whether it is sharp or flat and approximately by how much.
6. MISSED DYNAMICS: If a forte sounds like a mezzo-forte, or a piano sounds too loud, flag it.

WHAT "ISSUE SPANS MULTIPLE MEASURES" MEANS: If the same problem continues across several measures (e.g., rushing from m.5 to m.12, or consistently flat intonation in a phrase), report it as ONE flag with a measure range. Do not repeat the same issue as separate flags.

SCORING (be strict — most student recordings score 50–80):
- 90–100: Near-professional. Genuinely rare. No wrong notes, no squeaks, near-perfect intonation and rhythm.
- 75–89: Strong but with clear, audible issues. Minimum 3 flags.
- 60–74: Noticeable problems throughout. Minimum 4–5 flags.
- 45–59: Multiple significant errors. Minimum 6 flags.
- Below 45: Serious technical or accuracy problems. Minimum 7+ flags.
Each point deducted from 100 MUST correspond to a flag you are reporting.

Return ONLY valid JSON (no markdown fences, no explanation text):
{
  "score": <integer 0-100>,
  "flags": [
    {
      "measure_start": <integer — ABSOLUTE score measure where the issue BEGINS. Recording starts at measure ${opts.safeStart}${opts.safeEnd ? ` and ends at measure ${opts.safeEnd}` : ''}. Never reset to 1.>,
      "measure_end": <integer | null — ABSOLUTE score measure where the issue ENDS. Use null if the issue is confined to a single measure. Use a number if the issue spans multiple measures (e.g. rushing from m.5 to m.12 → measure_end: 12).>,
      "type": "timing"|"intonation"|"dynamics"|"technique"|"tone"|"error",
      "confidence": <integer 70-100>,
      "title": "<8 words max — be specific: name the note, direction, or technique failure>",
      "detail": "<3-5 sentences: (1) exactly what you heard and when, (2) name the specific note/beat/measure if relevant, (3) why it matters musically, (4) a concrete practice fix>",
      "timestamp_start": <seconds from start of video when this issue first occurs>,
      "timestamp_end": <seconds from start of video when this issue ends>
    }
  ]
}

Name exact pitches (e.g. "B♭4 arrived sharp by roughly a quarter tone"), exact beats ("rushed the dotted eighth–sixteenth on beat 3"), and exact technique ("bow left the string at the frog on the down-bow in m.7"). Never write vague feedback.`

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
    // Support both old (measure) and new (measure_start) field names
    const declaredRaw = Math.round(Number(f.measure_start ?? f.measure) || 0)
    let measure: number
    if (declaredRaw >= opts.safeStart && declaredRaw <= maxMeasure) {
      measure = declaredRaw
    } else if (spm && spm > 0 && ts > 0) {
      measure = opts.safeStart + Math.floor(ts / spm)
    } else {
      measure = opts.safeStart
    }
    measure = Math.max(opts.safeStart, Math.min(maxMeasure, measure))

    const declaredEnd = f.measure_end != null ? Math.round(Number(f.measure_end)) : null
    const measureEnd = declaredEnd != null && declaredEnd > measure && declaredEnd <= maxMeasure
      ? declaredEnd : null

    return {
      measure,
      measure_end:     measureEnd,
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
    text: `You are a conservatory-level music performance coach analyzing ${opts.frames.length} video frames from a student's recording. These frames are your only audio-visual evidence — analyze them with a critical eye.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${keyNote}Time signature: ${opts.timeSig}
Passage: ${measureRange}
${opts.tempo > 0 ? `Reference tempo: ${opts.tempo} BPM` : ''}

For each frame, assess ALL of the following — not just one or two:
- Embouchure / bow hold / hand position: visible tension, collapse, or misalignment
- Body posture: hunching, raised shoulders, jaw tension, tilted head
- Instrument angle or hold: deviations from ideal position
- Visible preparation: is the student bracing for difficult passages, or caught off guard?
- Facial expression: signs of uncertainty, tension, or loss of focus that predict upcoming errors
- For winds: lip and jaw position at the mouthpiece; for strings: bow angle, contact point, arm weight

Be strict. Most students have visible technique issues even in good performances.

Return ONLY valid JSON (no markdown fences):
{
  "score": <integer 0-100 — score the visible technique only, not intonation or rhythm you cannot hear>,
  "flags": [
    {
      "measure_start": <integer — ABSOLUTE score measure where the issue begins. Recording starts at measure ${opts.safeStart}. Never reset to 1.>,
      "measure_end": <integer | null — last measure if the issue spans multiple measures, null if single measure>,
      "type": "technique"|"timing"|"dynamics"|"intonation"|"tone"|"error",
      "confidence": <integer 70-100 — how clearly visible is this issue in the frames?>,
      "title": "<8 words max — name the body part and the specific failure>",
      "detail": "<3 sentences: (1) what is visible in which frame, (2) why this causes problems for sound or accuracy, (3) a specific physical exercise to fix it>",
      "timestamp_start": <seconds of the frame where the issue is most clearly visible>,
      "timestamp_end": <timestamp_start + 2.5>
    }
  ]
}

Give 4–6 flags. Always cite the frame timestamp and the specific body part or action. Never give advice that could apply to any student — be specific to what you see.`,
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
    const declaredRaw = Math.round(Number(f.measure_start ?? f.measure) || 0)
    let measure: number
    if (declaredRaw >= opts.safeStart && declaredRaw <= maxMeasure2) {
      measure = declaredRaw
    } else if (spm2 && spm2 > 0 && ts > 0) {
      measure = opts.safeStart + Math.floor(ts / spm2)
    } else {
      measure = opts.safeStart
    }
    measure = Math.max(opts.safeStart, Math.min(maxMeasure2, measure))
    const declaredEnd2 = f.measure_end != null ? Math.round(Number(f.measure_end)) : null
    const measureEnd2 = declaredEnd2 != null && declaredEnd2 > measure && declaredEnd2 <= maxMeasure2
      ? declaredEnd2 : null
    return {
      measure,
      measure_end:     measureEnd2,
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
    text: `You are a conservatory-level music performance coach. A student recorded themselves playing the passage below. You do not have the audio, but you have deep knowledge of this repertoire and instrument.

Piece: "${opts.pieceTitle}" by ${opts.composer}
Instrument: ${opts.instrument}
${keyNote}Time signature: ${opts.timeSig}
Passage: ${measureRange}
${hasImage ? '\nThe sheet music is shown above — study it carefully.' : ''}

Based on this specific passage and instrument, identify the 5–7 issues that students most commonly make here. Your flags must be grounded in the actual notes and rhythms of this passage — not generic advice.

Cover ALL of these dimensions — do not skip any:
- INTONATION: which specific intervals or notes are hardest to play in tune on this instrument in this key? Name the note and the tendency (sharp or flat).
- TIMING: where are the rhythmic traps? Dotted figures, syncopations, ornaments that students rush or mangle?
- DYNAMICS: which dynamic markings are hardest to execute? Where do students over-play or under-play?
- TECHNIQUE: what are the physical demands? Shifts, string crossings, valve combinations, register breaks, awkward fingerings?
- WRONG NOTES / ERRORS: are there passages where students commonly play the wrong pitch due to difficult fingering patterns or accidentals?
- If the passage has a consistent challenge spanning multiple measures (e.g. sustained pp intonation over mm.8–15), report it as a range.

Return ONLY valid JSON (no markdown):
{
  "flags": [
    {
      "measure_start": <integer — ABSOLUTE score measure where the issue begins, between ${opts.safeStart} and ${opts.safeEnd ?? opts.safeStart + 50}>,
      "measure_end": <integer | null — last measure of the issue if it spans multiple measures, null if single measure>,
      "type": "timing"|"intonation"|"dynamics"|"technique"|"tone"|"error",
      "confidence": 72,
      "title": "<8 words max — name the exact pitch, rhythm, or technique failure>",
      "detail": "<4 sentences: (1) the specific technical demand in this measure, (2) why students struggle with it on ${opts.instrument}, (3) what goes wrong (name the pitch, the beat, or the body movement), (4) a precise practice fix>",
      "timestamp_start": 0,
      "timestamp_end": 0
    }
  ]
}`,
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
    const declaredRaw3 = Math.round(Number(f.measure_start ?? f.measure) || 0)
    const measure = Math.max(opts.safeStart, Math.min(maxMeasure3,
      declaredRaw3 >= opts.safeStart ? declaredRaw3 : opts.safeStart
    ))
    const declaredEnd3 = f.measure_end != null ? Math.round(Number(f.measure_end)) : null
    const measureEnd3 = declaredEnd3 != null && declaredEnd3 > measure && declaredEnd3 <= maxMeasure3
      ? declaredEnd3 : null
    return {
      measure,
      measure_end:     measureEnd3,
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
  const CORS = corsHeaders(req)
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

    // ── Admin client (used for gate check + take insert + signed URLs) ────────
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ── Free tier gate: disabled during testing — re-enable before launch ────
    // const { data: sub } = await supabase
    //   .from('subscriptions').select('status, plan').eq('user_id', user.id).maybeSingle()
    // const isPro = sub?.status === 'active' && sub?.plan !== 'free'
    // if (!isPro) {
    //   const { count } = await admin.from('takes').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
    //   if ((count ?? 0) >= 1) {
    //     return new Response(
    //       JSON.stringify({ error: 'Free accounts include one analysis. Upgrade to Pro for unlimited analyses.' }),
    //       { status: 429, headers: { 'Content-Type': 'application/json', ...CORS } },
    //     )
    //   }
    // }

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
          120_000, 'Gemini'
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
