import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
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

    const body = await req.json()
    const {
      videoPath, videoMimeType,
      scorePath, scoreMimeType,
      pieceTitle, composer,
      timeSig, instrument,
      startMeasure, endMeasure,
    } = body

    if (!videoPath || !videoMimeType) {
      return new Response(JSON.stringify({ error: 'videoPath and videoMimeType are required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      })
    }

    const safeStart = Math.max(1, parseInt(String(startMeasure ?? 1), 10) || 1)
    const safeEnd: number | null = endMeasure ? Math.max(safeStart, parseInt(String(endMeasure), 10)) : null

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Create the take row immediately in processing state
    const { data: take, error: insertError } = await admin
      .from('takes')
      .insert({
        user_id:         user.id,
        piece_title:     pieceTitle  ?? 'Untitled',
        piece_composer:  composer    ?? 'Unknown',
        instrument:      instrument  ?? null,
        video_path:      videoPath,
        video_mime_type: videoMimeType,
        score_path:      scorePath   ?? null,
        score:           null,
        flags:           [],
        job_status:      'processing',
        job_started_at:  new Date().toISOString(),
      })
      .select('id')
      .single()

    if (insertError || !take) {
      throw new Error(`DB insert failed: ${insertError?.message}`)
    }

    const takeId = take.id

    // Generate 2-hour signed URLs for Modal to fetch directly
    const { data: vSigned } = await admin.storage
      .from('recordings')
      .createSignedUrl(videoPath, 7200)
    const videoSignedUrl = vSigned?.signedUrl ?? null

    let scoreSignedUrl: string | null = null
    if (scorePath) {
      const { data: sSigned } = await admin.storage
        .from('sheet-music')
        .createSignedUrl(scorePath, 7200)
      scoreSignedUrl = sSigned?.signedUrl ?? null
    }

    const modalUrl  = Deno.env.get('MODAL_WORKER_URL')
    const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/analysis-webhook`
    const webhookSecret = Deno.env.get('MODAL_WEBHOOK_SECRET')

    if (!modalUrl) {
      // No Modal worker configured — mark job as failed immediately
      await admin.from('takes').update({ job_status: 'failed', job_error: 'MODAL_WORKER_URL not configured' }).eq('id', takeId)
      return new Response(JSON.stringify({
        error: 'Analysis worker not configured.',
        code: 'WORKER_UNAVAILABLE',
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } })
    }

    // Fire-and-forget: 8s to hand off to Modal, then return immediately
    const dispatchPayload = {
      take_id:         takeId,
      webhook_url:     webhookUrl,
      webhook_secret:  webhookSecret,
      video_url:       videoSignedUrl,
      video_mime_type: videoMimeType,
      score_url:       scoreSignedUrl,
      score_mime_type: scoreMimeType ?? null,
      instrument:      instrument    ?? 'instrument',
      piece_title:     pieceTitle    ?? 'this piece',
      composer:        composer      ?? 'the composer',
      time_sig:        timeSig       ?? '4/4',
      start_measure:   safeStart,
      end_measure:     safeEnd,
      gemini_api_key:  Deno.env.get('GOOGLE_AI_API_KEY'),
      anthropic_api_key: Deno.env.get('ANTHROPIC_API_KEY'),
    }

    // Use 8s timeout for the dispatch call — we just need Modal to acknowledge receipt
    const dispatchRes = await fetch(`${modalUrl}/analyze_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dispatchPayload),
      signal: AbortSignal.timeout(8000),
    }).catch(async (err) => {
      console.error('[analyze-performance] Modal dispatch failed:', (err as Error).message)
      await admin.from('takes').update({
        job_status: 'failed',
        job_error:  `Dispatch failed: ${(err as Error).message}`,
      }).eq('id', takeId)
      return null
    })

    if (dispatchRes && !dispatchRes.ok) {
      const errText = await dispatchRes.text().catch(() => '')
      console.error('[analyze-performance] Modal dispatch HTTP error:', dispatchRes.status, errText.slice(0, 200))
      await admin.from('takes').update({
        job_status: 'failed',
        job_error:  `Dispatch HTTP ${dispatchRes.status}`,
      }).eq('id', takeId)
      return new Response(JSON.stringify({
        error: 'Failed to start analysis job.',
        code: 'DISPATCH_FAILED',
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } })
    }

    console.log('[analyze-performance] dispatched take', takeId, 'to Modal')

    return new Response(JSON.stringify({ jobId: takeId, status: 'processing' }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })

  } catch (err) {
    console.error('[analyze-performance] error:', (err as Error).message)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
