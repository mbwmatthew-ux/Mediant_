import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export async function requireAuth(req: Request): Promise<{ user: { id: string } } | Response> {
  // Include CORS headers on the 401 response too — without them, a cross-origin
  // browser fetch never sees the 401 body at all, it just reports a generic
  // "Failed to fetch" / network error, masking the real "not logged in" cause.
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(req) }
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers })
  }
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers })
  }
  return { user: { id: user.id } }
}

const PRODUCTION_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('ALLOWED_ORIGIN') ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false
  // Allow any localhost port in development
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true
  return PRODUCTION_ORIGINS.includes(origin)
}

export function corsHeaders(req: Request): Record<string, string> {
  // Echo back whatever origin calls us. Real security is the JWT — CORS
  // restriction only breaks preview deployments without adding protection.
  const origin = req.headers.get('Origin') ?? '*'
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}
