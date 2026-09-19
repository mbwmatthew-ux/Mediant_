import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, requireAuth } from '../_shared/cors.ts'

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const auth = await requireAuth(req)
  if (auth instanceof Response) return auth

  const jsonHeaders = { 'Content-Type': 'application/json', ...CORS }

  try {
    const { scorePath } = await req.json()
    if (!scorePath || typeof scorePath !== 'string') {
      return new Response(JSON.stringify({ error: 'scorePath is required' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data: signed, error: signErr } = await admin.storage
      .from('sheet-music')
      .createSignedUrl(scorePath, 300)
    if (signErr || !signed?.signedUrl) {
      return new Response(JSON.stringify({ error: 'Could not access the uploaded photo' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    const modalUrl = Deno.env.get('MODAL_SCORE_QUALITY_URL')
    if (!modalUrl) {
      return new Response(JSON.stringify({ error: 'Score quality check is not configured' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    const modalRes = await fetch(modalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Only the URL is sent. The worker enforces its own server-side
      // allowlist on the destination (see _check_score_quality) — a host
      // restriction supplied by the caller would be no restriction at
      // all, since a direct caller of that public endpoint controls both
      // halves of the comparison.
      body: JSON.stringify({ score_url: signed.signedUrl }),
      signal: AbortSignal.timeout(20000),
    }).catch(() => null)

    if (!modalRes || !modalRes.ok) {
      // A quality check that fails to run should never block the upload
      // flow — fail open, not closed.
      return new Response(JSON.stringify({ quality: 'unknown', interlinePx: null, is_screenshot: false }), {
        headers: jsonHeaders,
      })
    }

    const result = await modalRes.json()
    return new Response(JSON.stringify({
      quality: result.quality ?? 'unknown',
      interlinePx: result.interline_px ?? null,
      is_screenshot: result.is_screenshot ?? false,
    }), { headers: jsonHeaders })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
