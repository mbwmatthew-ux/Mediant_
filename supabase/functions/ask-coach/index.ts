import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'

const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) throw new Error('Unauthorized')

    const { message, context, history } = await req.json()
    if (!message) throw new Error('message is required')

    const flagSummary = (context.flags ?? [])
      .map((f: { measure: number; type: string; title: string }) =>
        `- Measure ${f.measure} (${f.type}): ${f.title}`)
      .join('\n')

    const system = `You are a warm, expert music coach helping a student improve their piano performance.

The student just performed "${context.pieceTitle ?? 'a piece'}" by ${context.pieceComposer ?? 'unknown composer'}.
Overall score: ${context.score != null ? `${context.score}/100` : 'not scored'}.
Issues identified:
${flagSummary || '(none)'}

Answer their questions helpfully and specifically. Be encouraging but honest. Keep responses to 2–4 sentences unless they ask for more detail.`

    const messages = [
      ...(history ?? []).map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: message },
    ]

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system,
      messages,
    })

    const reply = (response.content[0] as { type: string; text: string }).text.trim()

    return new Response(JSON.stringify({ reply }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
