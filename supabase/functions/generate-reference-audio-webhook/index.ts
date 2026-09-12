import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS })
  }

  const secret        = Deno.env.get('MODAL_WEBHOOK_SECRET')
  const incomingToken = req.headers.get('x-webhook-secret')
  if (!secret || incomingToken !== secret) {
    console.error('[generate-reference-audio-webhook] invalid or missing webhook secret')
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

  if (jobError) {
    console.error('[generate-reference-audio-webhook] job failed for take', takeId, ':', jobError)
    await admin.from('takes').update({
      reference_audio_job_status: 'failed',
      reference_audio_job_error:  String(jobError),
    }).eq('id', takeId)
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  const { audio_base64: audioBase64, timeline, bpm } = body as {
    audio_base64: string
    timeline: unknown
    bpm: number
  }
  if (!audioBase64) {
    return new Response(JSON.stringify({ error: 'audio_base64 is required when no error is present' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  // takeId's owner is not known here (the worker has no user session) —
  // the storage path must match what generate-reference-audio's own
  // cache-hit read expects, so it needs the owning user_id. Look it up.
  const { data: take, error: takeErr } = await admin
    .from('takes')
    .select('user_id')
    .eq('id', takeId)
    .single()
  if (takeErr || !take) {
    console.error('[generate-reference-audio-webhook] unknown take', takeId, takeErr?.message)
    return new Response(JSON.stringify({ error: 'Unknown take' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  const audioBytes  = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0))
  const storagePath = `${take.user_id}/${takeId}.wav`

  const { error: uploadErr } = await admin.storage
    .from('reference-audio')
    .upload(storagePath, audioBytes, { contentType: 'audio/wav', upsert: true })
  if (uploadErr) {
    console.error('[generate-reference-audio-webhook] storage upload failed:', uploadErr.message)
    await admin.from('takes').update({
      reference_audio_job_status: 'failed',
      reference_audio_job_error:  `Failed to store reference audio: ${uploadErr.message}`,
    }).eq('id', takeId)
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  console.log('[generate-reference-audio-webhook] writing result for take', takeId)
  await admin.from('takes').update({
    reference_audio_path:       storagePath,
    reference_audio_bpm:        bpm,
    reference_audio_timeline:   timeline ?? [],
    reference_audio_job_status: 'done',
    reference_audio_job_error:  null,
  }).eq('id', takeId)

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
})
