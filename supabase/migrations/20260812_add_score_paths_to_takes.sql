-- Multiple sheet-music pages per take. score_path (singular) stays as the first
-- page for backward compatibility with the existing analysis pipeline (Modal
-- worker, score_cache, annotate-flags, etc.) — none of that reads score_paths
-- yet. score_paths is purely additive: an ordered array of storage paths in the
-- `sheet-music` bucket, page 0 being the one score_path already points to.
ALTER TABLE takes ADD COLUMN IF NOT EXISTS score_paths JSONB;
