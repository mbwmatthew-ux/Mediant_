-- User profiles: role (student | teacher) and display info.
-- One row per auth.users row, auto-created on signup.

CREATE TABLE IF NOT EXISTS public.profiles (
  id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role         TEXT        NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher')),
  display_name TEXT,
  bio          TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users read/update their own profile
CREATE POLICY "profiles_own_select" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_own_update" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Teachers can read profiles of their students (needed for dashboard)
CREATE POLICY "profiles_teacher_select_students" ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.teacher_students ts
      WHERE ts.teacher_id = auth.uid()
        AND ts.student_id = public.profiles.id
        AND ts.status = 'active'
    )
  );

-- Students can read profiles of their teachers
CREATE POLICY "profiles_student_select_teachers" ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.teacher_students ts
      WHERE ts.student_id = auth.uid()
        AND ts.teacher_id = public.profiles.id
        AND ts.status = 'active'
    )
  );

-- Auto-create profile row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_profile();

-- Backfill existing users who predate this migration
INSERT INTO public.profiles (id)
SELECT id FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_profiles_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_profiles_updated_at();

CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
