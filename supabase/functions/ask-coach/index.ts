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

    const flags = (context.flags ?? []) as Array<{
      measure: number; type: string; title: string;
      body?: string; raw_detail?: string;
      timestamp_start?: number | null; timestamp_end?: number | null;
    }>

    const flagSummary = flags.length === 0
      ? '(no specific issues were flagged in this take)'
      : flags.map((f, i) => {
          const ts = (f.timestamp_start != null && f.timestamp_end != null)
            ? ` [audio ${f.timestamp_start.toFixed(1)}s–${f.timestamp_end.toFixed(1)}s]`
            : ''
          return `#${i + 1}. Measure ${f.measure} · ${f.type}${ts}
  Title: ${f.title}
  What was heard: ${f.raw_detail ?? '(not recorded)'}
  Coaching given to student: ${f.body ?? '(not recorded)'}`
        }).join('\n\n')

    const measuresFlagged = flags.map(f => f.measure)
    const measureRangeLine = measuresFlagged.length > 0
      ? `Measures with flagged issues: ${measuresFlagged.join(', ')}.`
      : ''

    const system = `You are a warm, expert music coach helping a student improve their performance.

The student just performed "${context.pieceTitle ?? 'a piece'}" by ${context.pieceComposer ?? 'unknown composer'}.
Overall score: ${context.score != null ? `${context.score}/100` : 'not scored'}.

${measureRangeLine}

DETAILED ISSUE LIST (this is the ONLY information you have about this take):
${flagSummary}

GROUNDING RULES — read carefully:
- The list above is your ENTIRE knowledge of this take. You did NOT hear the recording yourself.
- You do NOT know how far through the piece the student played, what tempo they took, or anything beyond what's in the list above.
- If the student asks about anything not covered above (e.g. "did I play measure 55?", "how was my tempo overall?"), say honestly that you don't have that information — never guess or invent measure numbers, dynamics, or events.
- When referencing an issue, cite the measure number EXACTLY as listed above. Do not refer to measures that are not in the list.
- Be encouraging but accurate. Keep responses to 2–4 sentences unless asked for more detail.`

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
