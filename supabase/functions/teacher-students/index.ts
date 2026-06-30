/**
 * teacher-students — manage teacher-student relationships.
 *
 * GET  /                         → list all relationships for the caller
 *                                  (teacher sees their students; student sees their teachers)
 * POST { studentEmail }          → teacher invites a student by email
 * PUT  { relationshipId, status: 'active'|'declined' }
 *                                → student accepts or declines an invite
 * DELETE ?relationshipId=<uuid>  → teacher removes a student / student removes a teacher
 *
 * GET /students/:studentId/takes → teacher fetches a specific student's takes (with flags)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey        = Deno.env.get('SUPABASE_ANON_KEY')!
    const authHeader     = req.headers.get('Authorization') ?? ''

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401, CORS)

    const admin = createClient(supabaseUrl, serviceRoleKey)

    const { data: profile } = await admin
      .from('profiles')
      .select('role, display_name')
      .eq('id', user.id)
      .single()

    const role = profile?.role ?? 'student'
    const url  = new URL(req.url)

    // ── GET: list relationships ──────────────────────────────────────────────
    if (req.method === 'GET') {
      // Special route: /teacher-students/student-takes?studentId=<uuid>
      const studentId = url.searchParams.get('studentId')
      if (studentId && role === 'teacher') {
        return await getStudentTakes(admin, user.id, studentId, CORS)
      }

      if (role === 'teacher') {
        const { data, error } = await admin
          .from('teacher_students')
          .select(`
            id, status, invited_at, accepted_at,
            student:profiles!teacher_students_student_id_fkey(id, display_name, role)
          `)
          .eq('teacher_id', user.id)
          .order('invited_at', { ascending: false })

        if (error) throw error
        return json({ relationships: data ?? [] }, 200, CORS)
      }

      // Student: see their teachers
      const { data, error } = await admin
        .from('teacher_students')
        .select(`
          id, status, invited_at, accepted_at,
          teacher:profiles!teacher_students_teacher_id_fkey(id, display_name, role)
        `)
        .eq('student_id', user.id)
        .order('invited_at', { ascending: false })

      if (error) throw error
      return json({ relationships: data ?? [] }, 200, CORS)
    }

    // ── POST: teacher invites student by email ───────────────────────────────
    if (req.method === 'POST') {
      if (role !== 'teacher') {
        return json({ error: 'Only teachers can invite students.' }, 403, CORS)
      }

      const { studentEmail } = await req.json()
      if (!studentEmail) return json({ error: 'studentEmail is required' }, 400, CORS)

      // Look up the student's auth user by email (service role required)
      const { data: users, error: lookupErr } = await admin.auth.admin.listUsers()
      if (lookupErr) throw lookupErr

      const studentUser = users.users.find(
        u => u.email?.toLowerCase() === studentEmail.toLowerCase()
      )
      if (!studentUser) {
        return json({ error: 'No Mediant account found for that email address.' }, 404, CORS)
      }
      if (studentUser.id === user.id) {
        return json({ error: 'You cannot invite yourself.' }, 400, CORS)
      }

      // Ensure student profile exists (backfill if missing)
      await admin.from('profiles').upsert({ id: studentUser.id }, { onConflict: 'id', ignoreDuplicates: true })

      const { data: rel, error: insertErr } = await admin
        .from('teacher_students')
        .upsert(
          { teacher_id: user.id, student_id: studentUser.id, status: 'pending' },
          { onConflict: 'teacher_id,student_id', ignoreDuplicates: false },
        )
        .select()
        .single()

      if (insertErr) throw insertErr
      return json({ relationship: rel }, 200, CORS)
    }

    // ── PUT: student accepts or declines ─────────────────────────────────────
    if (req.method === 'PUT') {
      const { relationshipId, status } = await req.json()
      if (!relationshipId) return json({ error: 'relationshipId is required' }, 400, CORS)
      if (!['active', 'declined'].includes(status)) {
        return json({ error: 'status must be "active" or "declined"' }, 400, CORS)
      }

      // Students can only update their own incoming relationships
      const { data: rel } = await admin
        .from('teacher_students')
        .select('id, student_id, status')
        .eq('id', relationshipId)
        .single()

      if (!rel) return json({ error: 'Relationship not found' }, 404, CORS)
      if (rel.student_id !== user.id) {
        return json({ error: 'You can only respond to your own invitations.' }, 403, CORS)
      }
      if (rel.status !== 'pending') {
        return json({ error: 'This invitation has already been responded to.' }, 400, CORS)
      }

      const { data: updated, error: updateErr } = await admin
        .from('teacher_students')
        .update({
          status,
          accepted_at: status === 'active' ? new Date().toISOString() : null,
        })
        .eq('id', relationshipId)
        .select()
        .single()

      if (updateErr) throw updateErr
      return json({ relationship: updated }, 200, CORS)
    }

    // ── DELETE: remove a relationship ─────────────────────────────────────────
    if (req.method === 'DELETE') {
      const relationshipId = url.searchParams.get('relationshipId')
      if (!relationshipId) return json({ error: 'relationshipId is required' }, 400, CORS)

      const { data: rel } = await admin
        .from('teacher_students')
        .select('id, teacher_id, student_id')
        .eq('id', relationshipId)
        .single()

      if (!rel) return json({ error: 'Relationship not found' }, 404, CORS)
      if (rel.teacher_id !== user.id && rel.student_id !== user.id) {
        return json({ error: 'Access denied' }, 403, CORS)
      }

      const { error: deleteErr } = await admin
        .from('teacher_students')
        .delete()
        .eq('id', relationshipId)

      if (deleteErr) throw deleteErr
      return json({ ok: true }, 200, CORS)
    }

    return json({ error: 'Method not allowed' }, 405, CORS)

  } catch (err) {
    console.error('[teacher-students]', (err as Error).message)
    return json({ error: (err as Error).message }, 500, CORS)
  }
})

async function getStudentTakes(
  admin: ReturnType<typeof createClient>,
  teacherId: string,
  studentId: string,
  cors: Record<string, string>,
) {
  // Verify active relationship
  const { data: rel } = await admin
    .from('teacher_students')
    .select('id')
    .eq('teacher_id', teacherId)
    .eq('student_id', studentId)
    .eq('status', 'active')
    .single()

  if (!rel) return json({ error: 'No active relationship with this student.' }, 403, cors)

  const { data: takes, error } = await admin
    .from('takes')
    .select(`
      id, piece_title, piece_composer, instrument, score, flags,
      job_status, analysis_quality, analysis_backend, created_at,
      song_id
    `)
    .eq('user_id', studentId)
    .eq('job_status', 'done')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw error

  // Attach any existing annotations from this teacher
  const takeIds = (takes ?? []).map((t: { id: string }) => t.id)
  let annotationsByTake: Record<string, unknown[]> = {}

  if (takeIds.length > 0) {
    const { data: annotations } = await admin
      .from('flag_annotations')
      .select('*')
      .eq('teacher_id', teacherId)
      .in('take_id', takeIds)

    for (const a of (annotations ?? [])) {
      const ann = a as { take_id: string }
      if (!annotationsByTake[ann.take_id]) annotationsByTake[ann.take_id] = []
      annotationsByTake[ann.take_id].push(a)
    }
  }

  const enriched = (takes ?? []).map((t: { id: string }) => ({
    ...t,
    teacherAnnotations: annotationsByTake[t.id] ?? [],
  }))

  return json({ takes: enriched }, 200, cors)
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}
