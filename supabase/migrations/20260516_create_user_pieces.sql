-- User-uploaded pieces
CREATE TABLE user_pieces (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title       TEXT        NOT NULL DEFAULT 'Untitled Piece',
  composer    TEXT        NOT NULL DEFAULT 'Unknown',
  instrument  TEXT        NOT NULL DEFAULT 'Unknown',
  era         TEXT        NOT NULL DEFAULT 'Unknown',
  difficulty  TEXT        NOT NULL DEFAULT 'Unknown',
  key         TEXT        NOT NULL DEFAULT 'Unknown',
  time        TEXT        NOT NULL DEFAULT 'Unknown',
  file_path   TEXT,
  file_url    TEXT,
  ai_summary  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_pieces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own pieces"
  ON user_pieces FOR ALL
  TO authenticated
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Storage bucket for sheet music files
INSERT INTO storage.buckets (id, name, public)
VALUES ('sheet-music', 'sheet-music', false)
ON CONFLICT DO NOTHING;

-- Users can upload and read their own files
CREATE POLICY "Users can upload sheet music"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'sheet-music' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can read own sheet music"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'sheet-music' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete own sheet music"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'sheet-music' AND (storage.foldername(name))[1] = auth.uid()::text);
