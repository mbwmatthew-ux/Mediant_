import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS })
  }

  // Verify shared secret so only Modal can call this endpoint
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

  // Job failed — write error state and exit
  if (jobError) {
    console.error('[analysis-webhook] job failed for take', takeId, ':', jobError)
    const { error: dbErr } = await admin
      .from('takes')
      .update({ job_status: 'failed', job_error: String(jobError) })
      .eq('id', takeId)
    if (dbErr) console.error('[analysis-webhook] db update failed:', dbErr.message)
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  // Job succeeded — write full result
  const {
    score,
    flags,
    measureLayout,
    audioAlignment,
    analysisQuality,
    analysisBackend,
  } = body as {
    score:           number
    flags:           unknown[]
    measureLayout:   unknown
    audioAlignment:  unknown
    analysisQuality: unknown
    analysisBackend: string
  }

  console.log('[analysis-webhook] writing result for take', takeId,
    '| score:', score, '| flags:', (flags ?? []).length,
    '| backend:', analysisBackend)

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
    })
    .eq('id', takeId)

  if (dbErr) {
    console.error('[analysis-webhook] db update failed:', dbErr.message)
    return new Response(JSON.stringify({ error: dbErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
})
