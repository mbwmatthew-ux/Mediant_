import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export async function requireAuth(req: Request): Promise<{ user: { id: string } } | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }
  return { user: { id: user.id } }
}

const ALLOWED_ORIGINS = [
  // Production — set ALLOWED_ORIGINS secret as comma-separated list, e.g.:
  // https://mediant-music.com,https://www.mediant-music.com
  ...(Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('ALLOWED_ORIGIN') ?? '')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Local dev
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
]

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] ?? '')
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}
