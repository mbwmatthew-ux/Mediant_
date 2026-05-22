import Anthropic from '@anthropic-ai/sdk'

const PROMPT = `Analyze this sheet music image and return ONLY a JSON object with these keys (no markdown fences, no extra text):
- "title": the piece title as printed (string or null)
- "composer": the composer name as printed (string or null)
- "era": one of "Baroque", "Classical", "Romantic", "Modern" — infer from composer/style
- "difficulty": one of "Beginner", "Intermediate", "Advanced" — based on notation complexity
- "key": null
- "time": time signature e.g. "4/4" or "3/4" (string or null)`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { imageBase64, mediaType } = req.body ?? {}
  if (!imageBase64 || !mediaType) {
    return res.status(400).json({ error: 'Missing image data' })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const imageContent = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageBase64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,           data: imageBase64 } }

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: [imageContent, { type: 'text', text: PROMPT }] }],
    })

    const raw = message.content[0].text.trim().replace(/^```(?:json)?\n?|\n?```$/g, '')
    const data = JSON.parse(raw)
    return res.status(200).json(data)
  } catch {
    return res.status(200).json({ title: null, composer: null, era: null, difficulty: null, key: null, time: null })
  }
}
