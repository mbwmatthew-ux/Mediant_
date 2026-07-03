-- ============================================================================
-- Pre-launch security hardening — round 2 (audit 2026-07-02)
--
-- Safe to run in the Supabase SQL editor as one block. Every statement is
-- idempotent, so re-running it (or running it after the 2026-07-01 migration)
-- causes no harm. This supersedes the need to apply 20260701_security_hardening
-- separately — it re-asserts those fixes too.
-- ============================================================================

-- 1) CRITICAL — remove the client-writable subscription policy.
--    It let ANY authenticated user upsert their own subscriptions row with
--    status='active', self-granting paid features and (once Stripe is live)
--    bypassing billing. The service-role policy still lets the Stripe webhook
--    write legitimately.
DROP POLICY IF EXISTS "Users can upsert own subscription" ON subscriptions;

-- 2) teacher_students — remove the direct client-side student UPDATE policy.
--    Every accept/decline already goes through the service-role `teacher-students`
--    edge function (which validates ownership + that the invite is still pending).
--    The raw policy additionally let a student re-activate a teacher-removed or
--    declined invite, regaining access to a teacher relationship they'd ended.
DROP POLICY IF EXISTS "ts_student_update" ON public.teacher_students;

-- 2b) CRITICAL — stop clients forging an ACTIVE teacher→student link.
--     The old `ts_teacher_all` policy was FOR ALL with WITH CHECK (auth.uid() =
--     teacher_id) and NO constraint on `status`. Any user could INSERT
--     {teacher_id: self, student_id: VICTIM, status: 'active'} straight through
--     PostgREST — no invite, no victim consent. The teacher-read policies on
--     profiles and reference_performances (and the teacher-students edge
--     function) then trust that active row, leaking the victim's profile,
--     reference performances, and — combined with a teacher role — their takes.
--     Replace the blanket policy with SELECT + DELETE only. All invites/accepts
--     now happen exclusively through the service-role edge function (which
--     creates rows as 'pending' and only lets the *student* activate). The
--     service role bypasses RLS, so the app keeps working unchanged.
DROP POLICY IF EXISTS "ts_teacher_all" ON public.teacher_students;
CREATE POLICY "ts_teacher_select" ON public.teacher_students FOR SELECT
  USING (auth.uid() = teacher_id);
CREATE POLICY "ts_teacher_delete" ON public.teacher_students FOR DELETE
  USING (auth.uid() = teacher_id);

-- 3) profiles — add the missing WITH CHECK so a self-update can't repoint the row id.
DROP POLICY IF EXISTS "profiles_own_update" ON public.profiles;
CREATE POLICY "profiles_own_update" ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 4) CRITICAL — lock the `profiles.role` column against self-promotion.
--    Previously the signup page (and any client) could write role='teacher'
--    directly, so any user could make themselves a "teacher" and start inviting
--    students. Role may now ONLY be changed by the backend (service role), i.e.
--    the `redeem-teacher-code` edge function after a valid invite code.
--    Normal users can still edit their other profile fields (display_name, bio);
--    the trigger silently pins `role` to its previous value for them.
CREATE OR REPLACE FUNCTION public.enforce_profile_role_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- The backend (service role) may set any role.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Any client-side insert is forced to 'student'.
    NEW.role := 'student';
    RETURN NEW;
  END IF;

  -- UPDATE by a normal user: role cannot change.
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    NEW.role := OLD.role;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_role_guard ON public.profiles;
CREATE TRIGGER profiles_role_guard
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_role_guard();

-- 5) HIGH — enable RLS on score_cache.
--    A table in the `public` schema with RLS disabled is fully readable AND
--    writable by anyone holding the public anon key (which ships in the website
--    bundle) via PostgREST. Without this, an attacker could read every cached
--    score or poison the cache so a victim's performance is graded against
--    attacker-controlled "correct notes". Enabling RLS with no policies denies
--    all anon/authenticated access; the service role bypasses RLS and keeps
--    the analysis webhook/worker working. IF NOT EXISTS covers the case where
--    this table has not been created yet.
CREATE TABLE IF NOT EXISTS public.score_cache (
  score_path    TEXT        PRIMARY KEY,
  parsed_notes  JSONB       NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.score_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.score_cache FROM anon, authenticated;
