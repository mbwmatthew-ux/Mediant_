/**
 * annotate-flags — teacher annotation CRUD for AI-generated flags.
 *
 * GET  ?takeId=<uuid>                   → list all annotations for a take
 * POST body: { takeId, flagIndex?, action, originalFlag?, editedFlag?, rejectionReason?, note }
 *            → upsert an annotation (teacher only)
 * DELETE ?takeId=<uuid>&flagIndex=<n>   → remove an annotation (teacher only)
 *
 * Only teachers (profiles.role = 'teacher') who have an active relationship
 * with the student who owns the take may annotate.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const VALID_ACTIONS = new Set(['approve', 'edit', 'reject', 'add'])
const VALID_REJECTION_REASONS = new Set([
  'wrong_measure', 'not_audible', 'too_harsh', 'not_actionable', 'duplicate', 'other',
])

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey        = Deno.env.get('SUPABASE_ANON_KEY')!
    const authHeader     = req.headers.get('Authorization') ?? ''

    // Auth
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user) {
      return json({ error: 'Unauthorized' }, 401, CORS)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey)

    // Verify the caller is a teacher
    const { data: profile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'teacher') {
      return json({ error: 'Only teachers can annotate flags.' }, 403, CORS)
    }

    // ── GET: list annotations for a take ────────────────────────────────────
    if (req.method === 'GET') {
      const url    = new URL(req.url)
      const takeId = url.searchParams.get('takeId')
      if (!takeId) return json({ error: 'takeId is required' }, 400, CORS)

      // Verify teacher has access to this take
      const access = await teacherCanAccessTake(admin, user.id, takeId)
      if (!access) return json({ error: 'Take not found or access denied' }, 404, CORS)

      const { data, error } = await admin
        .from('flag_annotations')
        .select('*')
        .eq('take_id', takeId)
        .order('created_at', { ascending: true })

      if (error) throw error
      return json({ annotations: data ?? [] }, 200, CORS)
    }

    // ── POST: upsert an annotation ───────────────────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json()
      const {
        takeId,
        flagIndex,       // null/undefined = teacher-added flag
        action,
        originalFlag,
        editedFlag,
        rejectionReason,
        note,
      } = body

      if (!takeId) return json({ error: 'takeId is required' }, 400, CORS)
      if (!VALID_ACTIONS.has(action)) {
        return json({ error: `action must be one of: ${[...VALID_ACTIONS].join(', ')}` }, 400, CORS)
      }
      if (action === 'reject' && rejectionReason && !VALID_REJECTION_REASONS.has(rejectionReason)) {
        return json({ error: `invalid rejectionReason` }, 400, CORS)
      }
      if ((action === 'edit' || action === 'add') && !editedFlag) {
        return json({ error: 'editedFlag is required for edit and add actions' }, 400, CORS)
      }
      if (action === 'add' && flagIndex != null) {
        return json({ error: 'flagIndex must be null for add actions' }, 400, CORS)
      }

      const access = await teacherCanAccessTake(admin, user.id, takeId)
      if (!access) return json({ error: 'Take not found or access denied' }, 404, CORS)

      const payload: Record<string, unknown> = {
        take_id:          takeId,
        teacher_id:       user.id,
        flag_index:       flagIndex ?? null,
        action,
        original_flag:    originalFlag ?? null,
        edited_flag:      editedFlag   ?? null,
        rejection_reason: rejectionReason ?? null,
        note:             note ?? null,
      }

      const { data, error } = await admin
        .from('flag_annotations')
        .upsert(payload, {
          onConflict: 'take_id,teacher_id,flag_index',
          ignoreDuplicates: false,
        })
        .select()
        .single()

      if (error) throw error
      return json({ annotation: data }, 200, CORS)
    }

    // ── DELETE: remove an annotation ─────────────────────────────────────────
    if (req.method === 'DELETE') {
      const url       = new URL(req.url)
      const takeId    = url.searchParams.get('takeId')
      const flagIndex = url.searchParams.get('flagIndex')

      if (!takeId) return json({ error: 'takeId is required' }, 400, CORS)

      const access = await teacherCanAccessTake(admin, user.id, takeId)
      if (!access) return json({ error: 'Take not found or access denied' }, 404, CORS)

      let query = admin
        .from('flag_annotations')
        .delete()
        .eq('take_id', takeId)
        .eq('teacher_id', user.id)

      if (flagIndex != null) {
        query = query.eq('flag_index', parseInt(flagIndex, 10))
      }

      const { error } = await query
      if (error) throw error
      return json({ ok: true }, 200, CORS)
    }

    return json({ error: 'Method not allowed' }, 405, CORS)

  } catch (err) {
    console.error('[annotate-flags]', (err as Error).message)
    return json({ error: (err as Error).message }, 500, CORS)
  }
})

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

async function teacherCanAccessTake(
  admin: ReturnType<typeof createClient>,
  teacherId: string,
  takeId: string,
): Promise<boolean> {
  // Get the take's owner
  const { data: take } = await admin
    .from('takes')
    .select('user_id')
    .eq('id', takeId)
    .single()

  if (!take) return false

  // Teacher can access if they have an active relationship with the student,
  // OR if the take belongs to the teacher themselves
  if (take.user_id === teacherId) return true

  const { data: rel } = await admin
    .from('teacher_students')
    .select('id')
    .eq('teacher_id', teacherId)
    .eq('student_id', take.user_id)
    .eq('status', 'active')
    .single()

  return !!rel
}
