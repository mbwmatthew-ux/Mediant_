-- V2 (staging-only, experimental) analyses already compute scorePracticeInsights
-- and performanceErrorAssessment (see modal_worker/score_practice_analysis.py
-- and worker.py's _run_analysis_v2), but neither field had a column to land in --
-- analysis-webhook/index.ts silently dropped both on every write. Adding them so
-- the results UI can actually read them back. See "MEDIANT -- Launch-Focused
-- Development Directive" (2026-11-10).
ALTER TABLE takes ADD COLUMN IF NOT EXISTS score_practice_insights JSONB;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS performance_error_assessment JSONB;
