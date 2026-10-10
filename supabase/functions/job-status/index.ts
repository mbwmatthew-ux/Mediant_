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

    // Self-heal: if a take has been stuck in 'processing' for longer than the
    // backend could ever legitimately still be running, mark it failed so the
    // frontend stops polling instead of waiting forever on an orphaned row.
    //
    // Was 5 * 60 * 1000. read_score_notes_claude now cross-validates with 2-3
    // sequential vision reads plus a per-measure resolution pass instead of 1
    // (see that function's docstring in worker.py), and run_full_analysis's own
    // Modal timeout is 890s to give that room — a self-heal window shorter than
    // the job it's watching fires on every legitimately-still-running analysis,
    // marking it "failed" while the backend is still correctly working and may
    // well finish successfully seconds later. Confirmed live: a real take ran
    // to Modal's own 890s timeout (killed mid-resolution-loop, logs show
    // "hit its timeout of 890s" at 14m55s) and was left stuck in 'processing'
    // forever, because nothing had polled job-status again after the frontend
    // gave up — this 5-minute self-heal would have fired LONG before that,
    // marking a still-healthy job "failed" out from under it on any take that
    // happened to take 5-14.8 minutes. 950s mirrors generate-reference-audio/
    // index.ts's identical fix (STUCK_JOB_MS) — comfortably above 890s, not
    // equal to it, so ordinary scheduling jitter doesn't trip it early.
    const STUCK_JOB_MS = 950 * 1000
    let effectiveStatus = take.job_status ?? 'done'
    let effectiveError  = take.job_error  ?? null
    if (effectiveStatus === 'processing' && take.job_started_at) {
      const ageMs = Date.now() - new Date(take.job_started_at).getTime()
      if (ageMs > STUCK_JOB_MS) {
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
