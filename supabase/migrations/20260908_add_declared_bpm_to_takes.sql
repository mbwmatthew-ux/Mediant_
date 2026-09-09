-- Per-take declared practice tempo: the BPM the student says they intend to play
-- at for this specific recording. Distinct from the sheet music's own printed
-- tempo marking (score.tempo_bpm, worker-side) — the same piece can be
-- practiced at different declared tempos across different sessions.
ALTER TABLE takes ADD COLUMN IF NOT EXISTS declared_bpm NUMERIC;
