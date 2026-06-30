import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const url     = new URL(req.url)
    const takeId  = url.searchParams.get('takeId')
    if (!takeId) {
      return new Response(JSON.stringify({ error: 'takeId is required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    const authHeader = req.headers.get('Authorization')!
    const supabase   = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    const { data: take, error: dbError } = await supabase
      .from('takes')
      .select('id, job_status, job_error, score, flags, analysis_quality, analysis_backend, job_started_at')
      .eq('id', takeId)
      .eq('user_id', user.id)
      .single()

    if (dbError || !take) {
      return new Response(JSON.stringify({ error: 'Take not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    // Self-heal: if a take has been stuck in 'processing' for over 5 minutes the
    // edge function that created it crashed without updating the DB. Mark it failed
    // now so the frontend stops polling instead of waiting the full 4-minute timeout.
    let effectiveStatus = take.job_status ?? 'done'
    let effectiveError  = take.job_error  ?? null
    if (effectiveStatus === 'processing' && take.job_started_at) {
      const ageMs = Date.now() - new Date(take.job_started_at).getTime()
      if (ageMs > 5 * 60 * 1000) {
        effectiveStatus = 'failed'
        effectiveError  = 'Analysis timed out — the server did not respond in time. Please try again.'
        const admin = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        )
        await admin.from('takes').update({
          job_status: 'failed',
          job_error:  effectiveError,
        }).eq('id', take.id).catch(() => {})
      }
    }

    return new Response(JSON.stringify({
      takeId:          take.id,
      status:          effectiveStatus,
      error:           effectiveError,
      score:           take.score      ?? null,
      flags:           take.flags      ?? [],
      analysisQuality: take.analysis_quality ?? null,
      analysisBackend: take.analysis_backend ?? null,
    }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
