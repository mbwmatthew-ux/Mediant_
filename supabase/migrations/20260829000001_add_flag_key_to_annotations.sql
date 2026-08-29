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
--
-- SUPERSEDED: 20260829000003 DROPS the unique index created below. It caused an
-- uncaught 500 whenever a take was re-analysed and the same issue re-annotated
-- at its new array position: annotate-flags upserts ON CONFLICT
-- (take_id, teacher_id, flag_index), that finds no row, and the resulting
-- INSERT then violates this index. Targeting the key instead is impossible —
-- Supabase's onConflict takes a bare column list and cannot express a partial
-- index's WHERE predicate. Read ...03 before reasoning about uniqueness here.
-- The SQL below is left exactly as applied; do not edit an applied migration.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_take_teacher_key
  ON public.flag_annotations(take_id, teacher_id, flag_key)
  WHERE flag_key IS NOT NULL;
