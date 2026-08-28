-- Stable per-flag identity for teacher annotations.
--
-- flag_index is the flag's POSITION in takes.flags. Re-running an analysis
-- reorders flags, so an annotation made before the re-run points at a different
-- flag afterwards — silently corrupting the ground truth these rows exist to be.
--
-- flag_key is derived from what the flag SAYS ("intonation:20"), assigned by
-- the worker after the measure-relabel pass, so it survives re-analysis.
-- flag_index is kept for backward compatibility with rows written before this.
ALTER TABLE public.flag_annotations ADD COLUMN IF NOT EXISTS flag_key TEXT;

CREATE INDEX IF NOT EXISTS idx_fa_flag_key ON public.flag_annotations(take_id, flag_key);

-- Teacher-added flags (action='add') have no AI original and so no key.
-- Everything else must be reachable by key once the worker is emitting them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_take_teacher_key
  ON public.flag_annotations(take_id, teacher_id, flag_key)
  WHERE flag_key IS NOT NULL;
