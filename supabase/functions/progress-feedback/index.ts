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

    const { period, takes } = await req.json()
    if (!Array.isArray(takes) || takes.length === 0) {
      throw new Error('No takes provided')
    }

    const summaries = takes.map((t: Record<string, unknown>) => {
      const flags = Array.isArray(t.flags)
        ? (t.flags as Record<string, unknown>[])
            .map(f => `m.${f.measure} (${f.type}): ${f.title}`)
            .join('; ')
        : 'none'
      return `- "${t.piece_title ?? 'Untitled'}" by ${t.piece_composer ?? 'Unknown'}, ${t.instrument ?? 'instrument unknown'}, score: ${t.score ?? 'N/A'}/100. Issues: ${flags}`
    }).join('\n')

    const anthropic = new Anthropic({ apiKey: anthropicKey })

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system: 'You are an expert music teacher giving constructive, encouraging progress feedback. Be specific about technical areas. Keep it concise.',
      messages: [
        {
          role: 'user',
          content: `Here are a student's practice sessions from the past ${period === 'weekly' ? 'week' : 'month'}:\n\n${summaries}\n\nWrite a ${period === 'weekly' ? 'weekly' : 'monthly'} practice review. Return ONLY a valid JSON object:\n{\n  "headline": "short motivating headline (max 12 words)",\n  "overview": "2-3 sentences summarising their practice pattern and overall progress",\n  "strengths": ["one specific strength shown this period", "another strength if applicable"],\n  "patterns": ["one recurring issue to address", "another pattern if present"],\n  "nextSteps": ["one concrete goal for next period", "another goal if helpful"]\n}`,
        },
      ],
    })

    const rawText = ((response.content[0] as { type: string; text: string })?.text ?? '{}').trim()
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    const stripped = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const json = stripped.startsWith('{')
      ? stripped
      : stripped.slice(stripped.indexOf('{'), stripped.lastIndexOf('}') + 1)

    let feedback: Record<string, unknown> = {}
    try { feedback = JSON.parse(json) } catch {
      throw new Error('Model returned invalid JSON')
    }

    return new Response(JSON.stringify({ feedback }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    console.error('[progress-feedback]', (err as Error).message)
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } },
    )
  }
})
