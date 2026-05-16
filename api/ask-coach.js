import Anthropic from '@anthropic-ai/sdk'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { message, context = {}, history = [] } = req.body ?? {}
  if (!message) return res.status(400).json({ error: 'Missing message' })

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const system = `You are a warm, expert music teacher coaching a student who just practiced "${context.pieceTitle ?? 'a piece'}" by ${context.pieceComposer ?? 'the composer'}.${context.score != null ? ` Their performance score was ${context.score}/100.` : ''}${context.flags?.length ? ` Issues flagged: ${context.flags.map(f => f.title).join(', ')}.` : ''} Give specific, encouraging advice in 2-4 sentences.`

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system,
      messages: [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: message },
      ],
    })
    res.status(200).json({ reply: response.content[0].text.trim() })
  } catch {
    res.status(500).json({ error: 'Coach unavailable' })
  }
}
