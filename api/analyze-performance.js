import Anthropic from '@anthropic-ai/sdk'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { pieceTitle, composer, instrument, part } = req.body ?? {}
  if (!pieceTitle) return res.status(400).json({ error: 'Missing pieceTitle' })

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const prompt = `You are an expert music teacher analyzing a student's practice recording of "${pieceTitle}" by ${composer ?? 'Unknown'}. Instrument: ${instrument ?? 'Piano'}.${part ? ` Movement/part: ${part}.` : ''}

Generate a realistic performance analysis with 2-4 specific issues a student commonly encounters with this piece. Return ONLY valid JSON, no markdown:
{
  "score": <integer 60-95>,
  "flags": [
    {
      "measure": <integer>,
      "type": "<timing|dynamics|voicing|articulation|intonation>",
      "title": "<6-10 word description of the specific issue>",
      "body": "<2-3 sentences of warm, actionable coaching with one concrete practice technique>"
    }
  ]
}`

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })

    const raw = message.content[0].text.trim().replace(/^```(?:json)?\n?|\n?```$/g, '')
    res.status(200).json(JSON.parse(raw))
  } catch {
    res.status(500).json({ error: 'Analysis failed' })
  }
}
