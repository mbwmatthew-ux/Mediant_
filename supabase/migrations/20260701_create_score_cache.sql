-- Cache parsed score notes by stable storage path.
-- Avoids re-running Claude vision on the same PDF every time a student submits a new recording.
CREATE TABLE score_cache (
  score_path    TEXT        PRIMARY KEY,
  parsed_notes  JSONB       NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Only the service role (backend) writes here; no RLS needed since students never
-- access this table directly.
