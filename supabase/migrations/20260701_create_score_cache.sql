-- Cache parsed score notes by stable storage path.
-- Avoids re-running Claude vision on the same PDF every time a student submits a new recording.
CREATE TABLE IF NOT EXISTS score_cache (
  score_path    TEXT        PRIMARY KEY,
  parsed_notes  JSONB       NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Only the service role (backend) reads/writes this table. It is NOT owner-scoped,
-- so it must never be reachable through the public API. In Supabase, a table in the
-- `public` schema with RLS *disabled* is fully exposed to the anon/authenticated
-- roles via PostgREST — so leaving RLS off here would let anyone with the public
-- anon key read every cached score, or poison the cache (write attacker-controlled
-- "correct notes" that a victim's analysis is then graded against).
-- Enable RLS with NO policies: this denies all anon/authenticated access while the
-- service role (used by the analysis webhook/worker) bypasses RLS and keeps working.
ALTER TABLE score_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON score_cache FROM anon, authenticated;
