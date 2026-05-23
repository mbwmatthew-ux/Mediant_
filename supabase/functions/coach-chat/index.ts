import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set')

    const { message, context, history } = await req.json()
    const { pieceTitle, pieceComposer, instrument, flags, activeFlag } = context ?? {}

    const flagsSummary = Array.isArray(flags) && flags.length > 0
      ? flags.map((f: Record<string, unknown>, i: number) =>
          `- m.${f.measure} (${f.type}): ${f.title ?? ''} — ${f.body ?? ''}`
        ).join('\n')
      : 'No issues flagged.'

    const activeFlagLine = activeFlag
      ? `\nThe student is currently asking about: measure ${activeFlag.measure}, issue type "${activeFlag.type}" — "${activeFlag.title}".`
      : ''

    const systemPrompt = [
      `You are an expert ${instrument ?? 'musician'} teacher providing one-on-one coaching.`,
      `The student just performed: "${pieceTitle ?? 'a piece'}"${pieceComposer ? ` by ${pieceComposer}` : ''}.`,
      `\nAnalysis flagged these issues:\n${flagsSummary}`,
      activeFlagLine,
      '\nGive concise, actionable coaching advice. Be warm but direct.',
      'Keep responses to 2–4 sentences unless a longer explanation is clearly needed.',
      'Focus on technique and musicality, not theory for its own sake.',
    ].join(' ')

    const priorMessages = Array.isArray(history)
      ? history.map((m: Record<string, string>) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      : []

    const anthropic = new Anthropic({ apiKey: anthropicKey })
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages: [
        ...priorMessages,
        { role: 'user', content: message },
      ],
    })

    const reply = (response.content[0] as { type: string; text: string })?.text ?? ''
    return new Response(JSON.stringify({ reply }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    console.error('[coach-chat]', (err as Error).message)
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } },
    )
  }
})
