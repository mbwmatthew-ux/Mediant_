import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.30.0'
import { corsHeaders } from '../_shared/cors.ts'

// ── Practice plan generation ──────────────────────────────────────────────────

async function generatePracticePlan(opts: {
  flags:       unknown[]
  pieceTitle:  string
  instrument:  string
  anthropicKey: string
}): Promise<unknown> {
  const { flags, pieceTitle, instrument, anthropicKey } = opts
  const client = new Anthropic({ apiKey: anthropicKey })

  const flagSummary = (flags as any[]).slice(0, 8).map(f =>
    `- ${f.type ?? 'issue'} in m.${f.measure ?? '?'}: ${f.title ?? ''} — ${(f.detail ?? f.body ?? '').slice(0, 120)}`
  ).join('\n')

  const prompt = `You are a music practice coach. A student just completed an AI analysis of "${pieceTitle}" on ${instrument}. Here are the issues the AI found:

${flagSummary}

Generate a focused 5-day practice plan to address these issues. Each day should be achievable in a single practice session.

Return ONLY valid JSON (no markdown):
{
  "summary": "<one sentence describing the overall focus for the week>",
  "days": [
    {
      "day": 1,
      "label": "<short label e.g. 'Intonation Focus'>",
      "tasks": [
        {
          "title": "<8 words max>",
          "description": "<2 sentences: what to do and how>",
          "minutes": <10-20>,
          "measure": <measure number or null>
        }
      ],
      "total_minutes": <sum of task minutes>
    }
  ]
}`

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages:   [{ role: 'user', content: prompt }],
  })

  const raw = (msg.content[0] as { type: string; text: string }).text ?? '{}'
  try {
    const start = raw.indexOf('{')
    const end   = raw.lastIndexOf('}')
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS })
  }

  const secret        = Deno.env.get('MODAL_WEBHOOK_SECRET')
  const incomingToken = req.headers.get('x-webhook-secret')
  if (!secret || incomingToken !== secret) {
    console.error('[analysis-webhook] invalid or missing webhook secret')
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  const { takeId, error: jobError } = body as { takeId: string; error?: string }
  if (!takeId) {
    return new Response(JSON.stringify({ error: 'takeId is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  // Job failed
  if (jobError) {
    console.error('[analysis-webhook] job failed for take', takeId, ':', jobError)
    await admin
      .from('takes')
      .update({ job_status: 'failed', job_error: String(jobError) })
      .eq('id', takeId)
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  const {
    score, flags, measureLayout, audioAlignment,
    analysisQuality, analysisBackend, pipelineDebug,
    parsedScoreNotes, scorePath,
  } = body as {
    score:            number
    flags:            unknown[]
    measureLayout:    unknown
    audioAlignment:   unknown
    analysisQuality:  unknown
    analysisBackend:  string
    pipelineDebug:    unknown
    parsedScoreNotes: unknown
    scorePath:        string | null
  }

  console.log('[analysis-webhook] writing result for take', takeId,
    '| score:', score, '| flags:', (flags ?? []).length,
    '| backend:', analysisBackend,
    '| cacheWrite:', Boolean(parsedScoreNotes && scorePath))

  // Write analysis result
  const { error: dbErr } = await admin
    .from('takes')
    .update({
      job_status:       'done',
      job_error:        null,
      score,
      flags,
      measure_layout:   measureLayout  ?? null,
      audio_alignment:  audioAlignment ?? null,
      analysis_quality: analysisQuality ?? null,
      analysis_backend: analysisBackend ?? null,
      pipeline_debug:   pipelineDebug  ?? null,
    })
    .eq('id', takeId)

  if (dbErr) {
    console.error('[analysis-webhook] db update failed:', dbErr.message)
    return new Response(JSON.stringify({ error: dbErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  // Store freshly-parsed score notes in cache (fire-and-forget)
  if (parsedScoreNotes && scorePath) {
    admin.from('score_cache')
      .upsert({ score_path: scorePath, parsed_notes: parsedScoreNotes }, { onConflict: 'score_path' })
      .then(() => console.log('[analysis-webhook] score cache written for', scorePath))
      .catch((e: Error) => console.warn('[analysis-webhook] score cache write failed:', e.message))
  }

  // Generate practice plan with Haiku (fire-and-forget — doesn't block response)
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (anthropicKey && Array.isArray(flags) && flags.length > 0) {
    // Fetch piece metadata from take so we can personalize the plan
    admin.from('takes')
      .select('piece_title, instrument')
      .eq('id', takeId)
      .maybeSingle()
      .then(async ({ data: take }) => {
        try {
          const plan = await generatePracticePlan({
            flags,
            pieceTitle:   take?.piece_title  ?? 'this piece',
            instrument:   take?.instrument   ?? 'your instrument',
            anthropicKey,
          })
          if (plan) {
            await admin.from('takes').update({ practice_plan: plan }).eq('id', takeId)
            console.log('[analysis-webhook] practice plan written for take', takeId)
          }
        } catch (e) {
          console.warn('[analysis-webhook] practice plan generation failed:', (e as Error).message)
        }
      })
      .catch(() => {})
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
})
