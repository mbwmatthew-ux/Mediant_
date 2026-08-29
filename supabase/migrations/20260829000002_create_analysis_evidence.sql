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

-- Service-role only. RLS is enabled with no policies, so anon and authenticated
-- are denied entirely. The service role bypasses RLS and can read the bundle.
-- This is the same posture as score_cache: diagnostics are stored server-side,
-- not exposed to the frontend.
ALTER TABLE public.analysis_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analysis_evidence FROM anon, authenticated;
