-- Reference performances for DTW alignment.
-- A teacher or student uploads a reference MIDI (or clean audio) for a piece.
-- The Modal worker downloads this and uses it to align the student's audio
-- against the reference note sequence, giving measure-accurate timestamps
-- even when the student plays freely (rubato, pauses, etc.).
--
-- file_type = 'midi'  → parsed as MIDI for note-sequence DTW
-- file_type = 'audio' → used for onset-level DTW (future)

CREATE TABLE IF NOT EXISTS public.reference_performances (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  song_id      UUID        REFERENCES public.songs(id) ON DELETE SET NULL,
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL,
  composer     TEXT,
  instrument   TEXT,
  file_path    TEXT        NOT NULL,
  file_type    TEXT        NOT NULL DEFAULT 'midi' CHECK (file_type IN ('midi', 'audio')),
  duration_sec FLOAT,
  note_count   INTEGER,
  tempo_bpm    FLOAT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.reference_performances ENABLE ROW LEVEL SECURITY;

-- Owners manage their references
CREATE POLICY "rp_owner_all" ON public.reference_performances FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Active teachers can read their students' references
CREATE POLICY "rp_teacher_read" ON public.reference_performances FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.teacher_students ts
      WHERE ts.teacher_id = auth.uid()
        AND ts.student_id = public.reference_performances.user_id
        AND ts.status = 'active'
    )
  );

-- Students can read references shared by their teachers
CREATE POLICY "rp_student_read_teacher" ON public.reference_performances FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.teacher_students ts
      WHERE ts.student_id = auth.uid()
        AND ts.teacher_id = public.reference_performances.user_id
        AND ts.status = 'active'
    )
  );

CREATE INDEX IF NOT EXISTS idx_rp_song_id ON public.reference_performances(song_id);
CREATE INDEX IF NOT EXISTS idx_rp_user_id ON public.reference_performances(user_id);

-- Signed-URL storage bucket (run separately in dashboard if bucket doesn't exist):
-- INSERT INTO storage.buckets (id, name, public) VALUES ('reference-midi', 'reference-midi', false);
