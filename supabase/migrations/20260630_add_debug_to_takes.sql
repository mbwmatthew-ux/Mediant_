-- Add pipeline debug field so every take records exactly what happened
-- and where failures occurred. This makes diagnosing audio detection
-- issues possible without reading Modal/Supabase logs manually.
ALTER TABLE public.takes
  ADD COLUMN IF NOT EXISTS pipeline_debug JSONB DEFAULT NULL;
