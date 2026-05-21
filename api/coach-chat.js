import Anthropic from '@anthropic-ai/sdk'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { message, context = {}, history = [] } = req.body ?? {}
  if (!message) return res.status(400).json({ error: 'Missing message' })

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const contextLines = []
  if (context.pieceTitle) {
    contextLines.push(
      `The student is currently working on "${context.pieceTitle}"${context.pieceComposer ? ` by ${context.pieceComposer}` : ''}.`
    )
  }
  if (context.score != null) {
    contextLines.push(`Their last recorded performance scored ${context.score}/100.`)
  }
  if (context.flags?.length) {
    contextLines.push(`Flagged issues from their last session: ${context.flags.map(f => f.title).join(', ')}.`)
  }

  const system = [
    'You are a warm, knowledgeable music teacher and practice coach built into Mediant, a music practice app.',
    'Help students improve through clear, encouraging, and practical advice about technique, theory, interpretation, and musical expression.',
    'IMPORTANT: Never recommend or mention any external apps, websites, tools, or resources — including tuner apps, metronome apps, YouTube, Spotify, sheet music sites, or any third-party software.',
    'If something like a tuner or metronome is relevant, refer only to features inside Mediant (e.g. "use the tuner in Mediant", "upload a recording and let Mediant analyze your intonation"). If Mediant does not yet have a relevant feature, give the advice as a pure technique tip without mentioning any external tool.',
    'Mediant\'s features include: uploading recordings, score review with measure-by-measure feedback, follow-along playback, session history, saved takes, a music library, and this coach chat.',
    'Keep responses focused — 2 to 5 sentences unless a longer explanation is genuinely needed. Speak like a real teacher, not a textbook.',
    ...contextLines,
  ].join(' ')

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
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
