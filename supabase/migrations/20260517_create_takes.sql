-- Practice takes (video submissions + AI analysis results)
CREATE TABLE takes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  piece_id         UUID,
  piece_title      TEXT        NOT NULL DEFAULT 'Untitled',
  piece_composer   TEXT        NOT NULL DEFAULT 'Unknown',
  video_path       TEXT        NOT NULL,
  video_mime_type  TEXT        NOT NULL DEFAULT 'video/mp4',
  score            INTEGER,
  flags            JSONB       NOT NULL DEFAULT '[]',
  duration_seconds INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE takes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own takes"
  ON takes FOR ALL
  TO authenticated
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Storage bucket for video recordings
INSERT INTO storage.buckets (id, name, public)
VALUES ('recordings', 'recordings', false)
ON CONFLICT DO NOTHING;

CREATE POLICY "Users can upload recordings"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'recordings' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can read own recordings"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'recordings' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete own recordings"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'recordings' AND (storage.foldername(name))[1] = auth.uid()::text);
