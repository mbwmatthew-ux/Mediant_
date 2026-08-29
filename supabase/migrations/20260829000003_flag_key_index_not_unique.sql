-- flag_key is a DATA column, not a constraint.
--
-- 20260829000001 created it as a partial UNIQUE index. That produces an uncaught
-- 500 in a reachable case: a teacher annotates a flag, the take is re-analysed,
-- the flags reorder, and the teacher annotates the same issue again at its new
-- array position. The edge function upserts ON CONFLICT (take_id, teacher_id,
-- flag_index); the new flag_index matches no row, so Postgres attempts an INSERT,
-- which then violates the unique flag_key index. ON CONFLICT does not dedupe
-- against indexes it was not given, so the request fails outright.
--
-- Targeting the key instead is not available: Supabase's onConflict takes a bare
-- column list and cannot express the WHERE flag_key IS NOT NULL predicate that a
-- partial index needs as an inference target.
--
-- Uniqueness here buys nothing. The accuracy scorer prefers the most recent row
-- per (take_id, flag_key), which is the correct reading anyway when a teacher has
-- annotated the same issue across two analyses of one take.
DROP INDEX IF EXISTS public.idx_fa_take_teacher_key;

-- Kept for lookup speed. idx_fa_flag_key from 20260829000001 already covers
-- (take_id, flag_key); this statement is idempotent insurance in case that
-- migration is ever reordered or partially applied.
CREATE INDEX IF NOT EXISTS idx_fa_flag_key
  ON public.flag_annotations(take_id, flag_key);
