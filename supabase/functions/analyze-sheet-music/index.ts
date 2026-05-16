import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROMPT = `You are a music educator analyzing a piece of sheet music.
Return ONLY a valid JSON object — no markdown, no explanation — with these exact fields:

{
  "title":      "piece title, or Untitled if unclear",
  "composer":   "composer full name, or Unknown",
  "instrument": "primary instrument (e.g. Piano, Violin, Flute, Cello, Guitar, Clarinet, Trumpet, Saxophone, Oboe, Horn, Harp, Viola)",
  "era":        "one of: Baroque, Classical, Romantic, Modern",
  "difficulty": "one of: Beginner, Intermediate, Advanced",
  "key":        "key signature, e.g. G major or D minor",
  "time":       "time signature, e.g. 4/4 or 3/4",
  "ai_summary": "2–3 sentences: describe the character of the piece and the 1–2 most important technical focus areas for a musician learning it"
}`

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) throw new Error('Unauthorized')

    const { filePath, fileType } = await req.json()
    if (!filePath || !fileType) throw new Error('filePath and fileType are required')

    // Download from Supabase Storage using service role
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: fileBlob, error: dlError } = await admin.storage
      .from('sheet-music')
      .download(filePath)
    if (dlError || !fileBlob) throw new Error(`Download failed: ${dlError?.message}`)

    const base64 = toBase64(await fileBlob.arrayBuffer())

    const isPdf = fileType === 'application/pdf'
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image',    source: { type: 'base64', media_type: fileType,           data: base64 } }

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: [contentBlock, { type: 'text', text: PROMPT }] }],
    })

    const raw  = (message.content[0] as { type: string; text: string }).text.trim()
    const json = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    const analysis = JSON.parse(json)

    return new Response(JSON.stringify(analysis), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
