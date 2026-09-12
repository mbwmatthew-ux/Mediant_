-- Job-status tracking for async reference-audio generation, mirroring the
-- existing takes.job_status/job_error/job_started_at columns used by the
-- main analysis pipeline. Needed because generating reference audio now
-- involves a multi-image Claude vision call (see split_page_into_rows,
-- 2026-09-10) slow enough to exceed Supabase Edge Functions' 150s
-- wall-clock limit if done synchronously — this pairs with converting
-- generate-reference-audio to spawn + webhook + poll.
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_job_status TEXT;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_job_error TEXT;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_job_started_at TIMESTAMPTZ;
