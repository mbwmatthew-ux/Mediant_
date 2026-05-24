import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROMPT = `You are a music educator with expert sight-reading ability analyzing a piece of sheet music.
Return ONLY a valid JSON object — no markdown, no explanation — with these exact fields:

{
  "title":      "piece title, or empty string if unclear",
  "composer":   "composer full name, or empty string if not visible",
  "era":        "one of: Baroque, Classical, Romantic, Modern — or empty string if unsure",
  "difficulty": "one of: Beginner, Intermediate, Advanced — based on notation complexity, or empty string if unsure",
  "key":        "key signature including whether it is major or minor, e.g. G major, D minor, B♭ major, F# minor — or empty string if not determinable",
  "time":       "time signature as two numbers separated by a slash, e.g. 4/4, 3/4, 6/8, 2/2, 12/8 — look for the stacked numerals immediately after the clef and key signature at the very start of the first staff. Do NOT guess; return empty string if you cannot clearly see the numerals.",
  "bpm":        <integer — the numeric value from the tempo marking, e.g. "Lento ♩ = 56" → 56, "Allegro ♩ = 132" → 132, "♩. = 80" → 80. Return 0 if there is no numeric tempo marking visible.>
}`

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set')

    const { imageBase64, mediaType } = await req.json()
    if (!imageBase64) throw new Error('imageBase64 is required')

    const anthropic = new Anthropic({ apiKey: anthropicKey })

    const isPdf = mediaType === 'application/pdf'
    const contentBlock = isPdf
      ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: imageBase64 } }
      : { type: 'image' as const,    source: { type: 'base64' as const, media_type: (mediaType ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: imageBase64 } }

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 256,
      messages:   [{ role: 'user', content: [contentBlock, { type: 'text', text: PROMPT }] }],
    })

    const raw  = ((message.content[0] as { type: string; text: string }).text ?? '{}').trim()
    const json = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)

    let analysis: Record<string, string> = {}
    try { analysis = JSON.parse(json) } catch { /* return empty — modal will show manual fields */ }

    return new Response(JSON.stringify(analysis), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
