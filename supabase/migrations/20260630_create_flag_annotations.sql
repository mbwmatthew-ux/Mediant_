-- Teacher annotations on AI-generated flags.
-- action = 'approve'  → teacher confirms the flag is correct
-- action = 'edit'     → teacher corrected the flag (edited_flag has the fix)
-- action = 'reject'   → teacher says the flag is wrong (rejection_reason says why)
-- action = 'add'      → teacher added a flag the AI missed (edited_flag is the new flag)
--
-- flag_index = NULL means the row is a teacher-added flag (no AI original)
-- rejection_reason values: 'wrong_measure' | 'not_audible' | 'too_harsh' | 'not_actionable' | 'duplicate' | 'other'
--
-- These rows ARE the training data. The edited/added flags are ground-truth examples;
-- rejections with reasons teach the system what patterns to avoid.

CREATE TABLE IF NOT EXISTS public.flag_annotations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  take_id           UUID        NOT NULL REFERENCES public.takes(id) ON DELETE CASCADE,
  teacher_id        UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  flag_index        INTEGER,
  action            TEXT        NOT NULL CHECK (action IN ('approve', 'edit', 'reject', 'add')),
  original_flag     JSONB,
  edited_flag       JSONB,
  rejection_reason  TEXT        CHECK (rejection_reason IN (
                      'wrong_measure', 'not_audible', 'too_harsh',
                      'not_actionable', 'duplicate', 'other'
                    )),
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(take_id, teacher_id, flag_index)
);

ALTER TABLE public.flag_annotations ENABLE ROW LEVEL SECURITY;

-- Teachers manage their own annotations
CREATE POLICY "fa_teacher_all" ON public.flag_annotations FOR ALL
  USING (auth.uid() = teacher_id)
  WITH CHECK (auth.uid() = teacher_id);

-- Students can read annotations on their own takes
CREATE POLICY "fa_student_read" ON public.flag_annotations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.takes t
      WHERE t.id = flag_annotations.take_id AND t.user_id = auth.uid()
    )
  );

-- Service role can read all (for prompt calibration queries)
CREATE POLICY "fa_service_read" ON public.flag_annotations FOR SELECT
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_fa_take_id    ON public.flag_annotations(take_id);
CREATE INDEX IF NOT EXISTS idx_fa_teacher_id ON public.flag_annotations(teacher_id);
CREATE INDEX IF NOT EXISTS idx_fa_action     ON public.flag_annotations(action);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_fa_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER fa_updated_at
  BEFORE UPDATE ON public.flag_annotations
  FOR EACH ROW EXECUTE FUNCTION public.update_fa_updated_at();
