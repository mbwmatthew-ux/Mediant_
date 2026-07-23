import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'
import { corsHeaders, requireAuth } from '../_shared/cors.ts'

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const auth = await requireAuth(req)
  if (auth instanceof Response) return auth

  try {
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropicKey) throw new Error('Summary service is not configured (missing API key). Contact support.')

    const { pieceTitle, pieceComposer, instrument, score, flags } = await req.json()

    // The worker can now return up to 40 individual flags (previously ~12, grouped).
    // Sending all of them makes for a very long prompt and a slower/costlier call for
    // no benefit — a session review only needs the most significant issues. Take the
    // strongest ones (by confidence) so the summary stays fast and focused.
    const flagList: Record<string, unknown>[] = Array.isArray(flags) ? flags : []
    const topFlags = [...flagList]
      .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
      .slice(0, 20)

    const flagSummary = topFlags.length > 0
      ? topFlags.map((f) => {
          const range = f.measure_end && f.measure_end !== f.measure ? `${f.measure}-${f.measure_end}` : f.measure
          return `- m.${range} (${f.type}): ${f.title}. ${f.detail ?? f.body ?? ''}`
        }).join('\n')
      : 'No issues detected.'

    const anthropic = new Anthropic({ apiKey: anthropicKey })

    const prompt = `Student performed "${pieceTitle ?? 'Untitled'}"${pieceComposer ? ` by ${pieceComposer}` : ''}${instrument ? ` on ${instrument}` : ''}.
Overall score: ${score != null ? `${score}/100` : 'not scored'}.

Issues flagged (${flagList.length} total${flagList.length > topFlags.length ? `, showing top ${topFlags.length}` : ''}):
${flagSummary}

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
}`

    // Retry once on a transient Anthropic failure (rate limit / momentarily overloaded)
    // instead of forcing the user to click "Try again" themselves for a blip.
    let response: Awaited<ReturnType<typeof anthropic.messages.create>> | null = null
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          system: `You are an expert, encouraging music teacher writing a post-session review.
Be specific and technical where relevant. Balance honest critique with genuine recognition of what the student did well.
Strengths should be specific things inferred from what was NOT flagged, or from the overall score and context — not just filler praise.
Improvements should give actionable guidance, not just restate the problem.`,
          messages: [{ role: 'user', content: prompt }],
        })
        break
      } catch (e) {
        lastErr = e
        const status = (e as { status?: number })?.status
        if (attempt === 0 && (status === 429 || status === 529 || status === 500)) {
          await new Promise((r) => setTimeout(r, 800))
          continue
        }
        throw e
      }
    }
    if (!response) throw lastErr instanceof Error ? lastErr : new Error('Anthropic request failed')

    const rawText = ((response.content[0] as { type: string; text: string })?.text ?? '{}').trim()
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    const stripped = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const braceStart = stripped.indexOf('{')
    const braceEnd = stripped.lastIndexOf('}')
    const json = stripped.startsWith('{')
      ? stripped
      : (braceStart >= 0 && braceEnd > braceStart ? stripped.slice(braceStart, braceEnd + 1) : '')

    if (!json) {
      console.error('[analysis-summary] no JSON object in model output:', rawText.slice(0, 300))
      throw new Error('The AI response could not be read. Please try again.')
    }

    let summary: Record<string, unknown> = {}
    try { summary = JSON.parse(json) } catch {
      console.error('[analysis-summary] JSON.parse failed on:', json.slice(0, 300))
      throw new Error('The AI response could not be read. Please try again.')
    }

    return new Response(JSON.stringify({ summary }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  } catch (err) {
    const e = err as { message?: string; status?: number }
    console.error('[analysis-summary]', e.message, e.status ? `(status ${e.status})` : '')
    // Give the user an actionable message for the common transient cases; anything
    // else falls back to the underlying error text (still safe — no secrets in it).
    const userMessage =
      e.status === 429 ? 'The AI service is busy right now. Please try again in a moment.'
      : e.status === 529 || e.status === 503 ? 'The AI service is temporarily overloaded. Please try again shortly.'
      : e.status === 401 || e.status === 403 ? 'Summary service authentication failed. Contact support.'
      : (e.message || 'Could not generate summary.')
    return new Response(
      JSON.stringify({ error: userMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } },
    )
  }
})
