ALTER TABLE takes ADD COLUMN IF NOT EXISTS job_status  TEXT    NOT NULL DEFAULT 'done';
ALTER TABLE takes ADD COLUMN IF NOT EXISTS job_started_at TIMESTAMPTZ;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS job_error  TEXT;

-- Back-fill existing rows so they are not stuck in pending state
UPDATE takes SET job_status = 'done' WHERE job_status = 'pending';
