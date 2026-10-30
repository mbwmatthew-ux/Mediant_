-- Mediant — Launch-Readiness Audit: read-only queries for the Supabase SQL Editor
--
-- Per the owner's 2026-10-30 "Gate 2 Recovery and Launch-Readiness Directive,"
-- Track B. No service-role key or DB connection string was used or requested
-- to write these — they were authored purely by reading the schema in
-- supabase/migrations/. Every query is SELECT-only, returns only aggregate
-- counts or non-sensitive metadata (no raw recordings, no emails, no
-- free-text content), and is safe to paste into the Supabase dashboard's
-- SQL Editor (Project: Mediant-collaboration) as-is.
--
-- The 199-completed-takes figure referenced elsewhere in this project
-- (AGENT_TASKS.md, 2026-10-11 full-audit entry) is PREVIOUSLY REPORTED, not
-- independently re-verified here — Query 1 lets you confirm it's still
-- current before relying on any of the counts below.

-- ============================================================
-- 1. Total takes and completion status (verifies/refreshes the
--    previously-reported 199-take figure)
-- ============================================================
SELECT
  job_status,
  COUNT(*) AS take_count
FROM takes
GROUP BY job_status
ORDER BY take_count DESC;

-- ============================================================
-- 2. Performances by instrument
--    (instrument is nullable — a non-null count here is how many takes
--    actually have it set; NULLs are a data-quality gap worth knowing about)
-- ============================================================
SELECT
  COALESCE(instrument, '(not set)') AS instrument,
  COUNT(*) AS take_count,
  COUNT(*) FILTER (WHERE job_status = 'done') AS completed_count
FROM takes
GROUP BY instrument
ORDER BY take_count DESC;

-- ============================================================
-- 3. Recordings with vs. without associated sheet music
--    score_path is the single/first-page field every analysis path reads;
--    score_paths is the newer multi-page array (additive, not yet read by
--    the main pipeline per its own migration comment).
-- ============================================================
SELECT
  (score_path IS NOT NULL) AS has_score_path,
  (score_paths IS NOT NULL AND jsonb_array_length(score_paths) > 0) AS has_score_paths_array,
  COUNT(*) AS take_count
FROM takes
GROUP BY 1, 2
ORDER BY take_count DESC;

-- ============================================================
-- 4. Analysis completion and failure counts, with reasons where recorded
--    (job_error is free text written by the worker/edge function on
--    failure — truncated here to avoid pulling back anything long or
--    unexpectedly sensitive; still safe since it's an internal error
--    string, not user content, but kept short by convention)
-- ============================================================
SELECT
  job_status,
  COUNT(*) AS take_count,
  COUNT(DISTINCT user_id) AS distinct_users_affected,
  COUNT(*) FILTER (WHERE job_error IS NOT NULL) AS with_error_message
FROM takes
GROUP BY job_status;

-- Top distinct failure messages (if any), capped and truncated —
-- useful for spotting one systemic failure vs. many one-off causes.
SELECT
  LEFT(job_error, 120) AS job_error_prefix,
  COUNT(*) AS occurrences
FROM takes
WHERE job_status = 'failed' AND job_error IS NOT NULL
GROUP BY 1
ORDER BY occurrences DESC
LIMIT 20;

-- ============================================================
-- 5. Recording durations and quality indicators
-- ============================================================
SELECT
  COUNT(*) AS take_count,
  MIN(duration_seconds) AS min_duration_sec,
  ROUND(AVG(duration_seconds)) AS avg_duration_sec,
  MAX(duration_seconds) AS max_duration_sec,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_seconds) AS median_duration_sec
FROM takes
WHERE job_status = 'done';

-- Quality/trust breakdown from the worker's own self-reported
-- analysis_quality JSONB (trust: 'high' | 'medium', never a measured
-- accuracy number — see caveat below).
SELECT
  COALESCE(analysis_quality->>'trust', '(not set)') AS trust_level,
  COUNT(*) AS take_count,
  COUNT(*) FILTER (
    WHERE jsonb_array_length(COALESCE(analysis_quality->'coverage'->'caveats', '[]'::jsonb)) > 0
  ) AS take_count_with_coverage_caveats
FROM takes
WHERE job_status = 'done'
GROUP BY 1
ORDER BY take_count DESC;

-- Page-coverage completeness: how many completed takes had every uploaded
-- score page actually read by the analysis.
SELECT
  COUNT(*) AS completed_with_pages_total,
  COUNT(*) FILTER (
    WHERE (analysis_quality->'coverage'->>'pages_analysed')::int
        < (analysis_quality->'coverage'->>'pages_total')::int
  ) AS partial_page_coverage_count
FROM takes
WHERE job_status = 'done'
  AND analysis_quality->'coverage'->>'pages_analysed' IS NOT NULL
  AND analysis_quality->'coverage'->>'pages_total' IS NOT NULL;

-- ============================================================
-- 6. Candidate pool for teacher annotation: completed takes that produced
--    at least one flag and have NOT yet been annotated by any teacher.
--    This is the real sampling universe for Track C's ~20-take plan.
-- ============================================================
SELECT
  COALESCE(t.instrument, '(not set)') AS instrument,
  COUNT(*) AS unannotated_flagged_completed_takes
FROM takes t
WHERE t.job_status = 'done'
  AND jsonb_array_length(COALESCE(t.flags, '[]'::jsonb)) > 0
  AND NOT EXISTS (
    SELECT 1 FROM flag_annotations fa WHERE fa.take_id = t.id
  )
GROUP BY 1
ORDER BY unannotated_flagged_completed_takes DESC;

-- For comparison: how many takes already have at least one teacher
-- annotation today (should be at or near zero per the 2026-10-11 audit —
-- this query lets you re-confirm that's still true before Track C starts).
SELECT COUNT(DISTINCT take_id) AS takes_with_any_annotation
FROM flag_annotations;

-- ============================================================
-- 7. Active teachers (context for who could actually do the ~20-take
--    annotation pass in Track C — count only, no names/emails)
-- ============================================================
SELECT
  status,
  COUNT(*) AS relationship_count,
  COUNT(DISTINCT teacher_id) AS distinct_teachers
FROM teacher_students
GROUP BY status;
