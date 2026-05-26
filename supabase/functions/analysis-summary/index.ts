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

    const { pieceTitle, pieceComposer, instrument, score, flags } = await req.json()

    const flagSummary = Array.isArray(flags) && flags.length > 0
      ? flags.map((f: Record<string, unknown>) =>
          `- m.${f.measure} (${f.type}): ${f.title}. ${f.detail ?? f.body ?? ''}`
        ).join('\n')
      : 'No issues detected.'

    const anthropic = new Anthropic({ apiKey: anthropicKey })

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: `You are an expert, encouraging music teacher writing a post-session review.
Be specific and technical where relevant. Balance honest critique with genuine recognition of what the student did well.
Strengths should be specific things inferred from what was NOT flagged, or from the overall score and context — not just filler praise.
Improvements should give actionable guidance, not just restate the problem.`,
      messages: [
        {
          role: 'user',
          content: `Student performed "${pieceTitle ?? 'Untitled'}"${pieceComposer ? ` by ${pieceComposer}` : ''}${instrument ? ` on ${instrument}` : ''}.
Overall score: ${score != null ? `${score}/100` : 'not scored'}.

Issues flagged:\n${flagSummary}

Write a balanced session review. Return ONLY valid JSON:
{
  "headline": "one engaging sentence summarising the session (max 15 words)",
  "overview": "2-3 sentences: overall impression, score context, and what stands out most",
  "strengths": [
    "specific positive observation 1",
    "specific positive observation 2"
  ],
  "improvements": [
    { "area": "short label", "guidance": "one concrete, actionable sentence on how to fix it" },
    { "area": "short label", "guidance": "one concrete, actionable sentence on how to fix it" }
  ]
}`,
        },
      ],
    })

    const rawText = ((response.content[0] as { type: string; text: string })?.text ?? '{}').trim()
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    const stripped = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const json = stripped.startsWith('{')
      ? stripped
      : stripped.slice(stripped.indexOf('{'), stripped.lastIndexOf('}') + 1)

    let summary: Record<string, unknown> = {}
    try { summary = JSON.parse(json) } catch {
      throw new Error('Model returned invalid JSON')
    }

    return new Response(JSON.stringify({ summary }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    console.error('[analysis-summary]', (err as Error).message)
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } },
    )
  }
})
