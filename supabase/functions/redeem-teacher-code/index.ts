/**
 * redeem-teacher-code — sanctioned path to become a teacher.
 *
 * Teacher accounts can see an accepted student's practice data, so we don't let
 * anyone self-assign the role. Instead the caller submits an invite code; if it
 * matches the server-side secret, we (service role) set their profiles.role to
 * 'teacher'. The DB trigger `profiles_role_guard` blocks every other path.
 *
 * POST { code }  → { ok: true } on success.
 *
 * Requires the Supabase secret TEACHER_INVITE_CODE to be set (Project Settings →
 * Edge Functions → Secrets, or `supabase secrets set TEACHER_INVITE_CODE=...`).
 * If it is unset, the function FAILS CLOSED — nobody can become a teacher until
 * the owner picks a code. Use a long, random value and share it only with
 * teachers you have vetted.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

// Constant-time-ish string compare so a wrong code can't be narrowed by timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, CORS)
  }

  try {
    // 1) Authenticate the caller from their JWT.
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    )
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return json({ error: 'Unauthorized' }, 401, CORS)

    // 2) Fail closed if no code is configured.
    const expected = Deno.env.get('TEACHER_INVITE_CODE') ?? ''
    if (!expected) {
      console.error('[redeem-teacher-code] TEACHER_INVITE_CODE is not set — refusing all upgrades')
      return json({ error: 'Teacher signups are not open yet. Please contact the Mediant team.' }, 403, CORS)
    }

    // 3) Check the submitted code.
    let body: { code?: unknown }
    try { body = await req.json() } catch { return json({ error: 'Invalid request' }, 400, CORS) }
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!code || !safeEqual(code, expected)) {
      return json({ error: 'That teacher code is not valid.' }, 403, CORS)
    }

    // 4) Grant the role via the service role (bypasses the role guard).
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    // Ensure the profile row exists, then promote to teacher.
    await admin.from('profiles').upsert({ id: user.id }, { onConflict: 'id', ignoreDuplicates: true })
    const { error: updErr } = await admin
      .from('profiles')
      .update({ role: 'teacher' })
      .eq('id', user.id)
    if (updErr) throw updErr

    console.log('[redeem-teacher-code] promoted', user.id, 'to teacher')
    return json({ ok: true, role: 'teacher' }, 200, CORS)

  } catch (err) {
    console.error('[redeem-teacher-code]', (err as Error).message)
    return json({ error: 'Something went wrong. Please try again.' }, 500, CORS)
  }
})

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...cors },
  })
}
