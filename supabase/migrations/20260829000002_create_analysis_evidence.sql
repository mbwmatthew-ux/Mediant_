-- Raw measurements behind each analysis, one row per take.
--
-- Deliberately NOT a column on `takes`: several pages select takes wholesale,
-- and a bundle is up to ~1 MB. Keeping it in its own table means the analysis
-- list queries are unaffected.
--
-- This is the input to threshold calibration. Joined against flag_annotations
-- (teacher ground truth) it answers "what measurement produced the flag the
-- teacher rejected?", which nothing could answer before.
CREATE TABLE IF NOT EXISTS public.analysis_evidence (
  take_id     UUID        PRIMARY KEY REFERENCES public.takes(id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL DEFAULT 1,
  bundle      JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Same posture as score_cache: a public-schema table with RLS disabled is fully
-- exposed through PostgREST to anyone holding the anon key. Enable RLS with no
-- write policy; the service role bypasses RLS and keeps working.
ALTER TABLE public.analysis_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analysis_evidence FROM anon, authenticated;

-- Students may read the evidence for their own takes; nobody may write it
-- through the public API.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'analysis_evidence' AND policyname = 'ae_owner_read'
  ) THEN
    CREATE POLICY "ae_owner_read" ON public.analysis_evidence FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.takes t
          WHERE t.id = analysis_evidence.take_id AND t.user_id = auth.uid()
        )
      );
  END IF;
END $$;
