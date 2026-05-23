import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
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
      .select('id, job_status, job_error, score, flags, analysis_quality, analysis_backend')
      .eq('id', takeId)
      .eq('user_id', user.id)
      .single()

    if (dbError || !take) {
      return new Response(JSON.stringify({ error: 'Take not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    return new Response(JSON.stringify({
      takeId:          take.id,
      status:          take.job_status ?? 'done',
      error:           take.job_error  ?? null,
      score:           take.score      ?? null,
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
