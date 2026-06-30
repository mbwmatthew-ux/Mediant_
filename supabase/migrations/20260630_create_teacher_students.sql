-- Teacher-student relationships.
-- Teachers invite students by email; students accept or decline.

CREATE TABLE IF NOT EXISTS public.teacher_students (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id   UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id   UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'declined', 'removed')),
  invited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(teacher_id, student_id)
);

ALTER TABLE public.teacher_students ENABLE ROW LEVEL SECURITY;

-- Teachers manage relationships they created
CREATE POLICY "ts_teacher_all" ON public.teacher_students FOR ALL
  USING (auth.uid() = teacher_id)
  WITH CHECK (auth.uid() = teacher_id);

-- Students can read and update their status (accept/decline)
CREATE POLICY "ts_student_select" ON public.teacher_students FOR SELECT
  USING (auth.uid() = student_id);

CREATE POLICY "ts_student_update" ON public.teacher_students FOR UPDATE
  USING (auth.uid() = student_id);

CREATE INDEX IF NOT EXISTS idx_ts_teacher_id ON public.teacher_students(teacher_id);
CREATE INDEX IF NOT EXISTS idx_ts_student_id ON public.teacher_students(student_id);
CREATE INDEX IF NOT EXISTS idx_ts_status     ON public.teacher_students(status);
