-- Pre-launch security hardening (audit 2026-07-01)
-- Apply with `supabase db push` (or run in the Supabase SQL editor).

-- 1) CRITICAL — remove the client-writable subscription policy.
--    It let ANY authenticated user upsert their own subscriptions row with
--    status='active', self-granting paid features and (once Stripe is live)
--    bypassing billing. The service-role policy from 20260515 still lets the
--    Stripe webhook write legitimately.
DROP POLICY IF EXISTS "Users can upsert own subscription" ON subscriptions;

-- 2) teacher_students — the app performs every invite/accept/decline through
--    the service-role `teacher-students` edge function, so this direct
--    client-side student UPDATE policy is unused AND lets a student re-activate
--    a teacher-removed/declined invite (regaining access to the teacher's data).
--    Remove it; the edge function keeps working (service role bypasses RLS).
DROP POLICY IF EXISTS "ts_student_update" ON public.teacher_students;

-- 3) profiles — add the missing WITH CHECK so a self-update can't repoint the
--    row id. (Whether teacher accounts should be vetted rather than self-service
--    is a product decision — see the launch notes; if you want to lock the role
--    column, we can add a BEFORE UPDATE trigger that pins profiles.role.)
DROP POLICY IF EXISTS "profiles_own_update" ON public.profiles;
CREATE POLICY "profiles_own_update" ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
