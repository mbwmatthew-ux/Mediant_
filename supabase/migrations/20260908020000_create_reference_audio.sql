-- Reference-audio: AI-synthesized "how this piece should sound" recordings,
-- generated lazily (first request per take) and cached forever after via
-- takes.reference_audio_path. One file per take, stored at
-- reference-audio/{user_id}/{take_id}.wav — server-generated, so INSERT uses
-- upsert from the edge function's service-role client (bypasses these RLS
-- policies entirely; the policies below only govern direct client access).
INSERT INTO storage.buckets (id, name, public)
VALUES ('reference-audio', 'reference-audio', false)
ON CONFLICT DO NOTHING;

CREATE POLICY "Users can read own reference audio"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'reference-audio' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete own reference audio"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'reference-audio' AND (storage.foldername(name))[1] = auth.uid()::text);

-- No client-side INSERT policy: only the edge function's service-role client
-- (which bypasses RLS) ever writes to this bucket. A client-side INSERT
-- policy would let a user upload arbitrary "reference audio" as themselves,
-- which is meaningless here — generation is always server-driven.

-- Per-take cache of the generated reference audio. Nullable: absent until
-- first requested. reference_audio_bpm records what tempo the cached file
-- was actually rendered at (always declared_bpm at generation time today,
-- since declared_bpm is immutable once set — stored defensively in case a
-- future change makes declared_bpm editable, so a stale cache becomes
-- detectable rather than silently wrong).
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_path TEXT;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_bpm NUMERIC;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_timeline JSONB;
