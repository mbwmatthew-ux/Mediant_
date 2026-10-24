# Visual validation anchor cases

Real (or, for `proof_of_mechanism`, deterministically-generated) examples
scored individually by name, separate from the synthetic corpus's
aggregate percentage — mirrors how pieces 2186/2293 are tracked
individually on the audio side.

Each anchor is a directory containing `page{N}.png` file(s) and a
`ground_truth.json` with `{"measures": [...]}` in the same schema as the
main corpus.

## `proof_of_mechanism/`

NOT a real failure case. One page from the already-built MusicNet corpus
(piece 2191), whose ground truth is copied directly from
`ground_truth.json` rather than hand-transcribed. Exists only to prove
the anchor-loading/scoring mechanism works end to end with a fixture
that is trivially, confidently correct.

## Deferred: the real EXIF-rotation clarinet case

`modal_worker/testdata/real_photo_sideways_exif_portrait.jpg` is the real
photo that caused the 2026-10-01 EXIF-orientation bug (see that fix's
session note and `test_split_page_into_rows_recovers_real_systems_once_
orientation_is_fixed` in `test_analysis.py`, which already confirms the
STRUCTURAL bug — rows fragmenting, Audiveris returning zero measures —
but has no ground truth for the actual NOTE CONTENT).

Deliberately NOT added as an anchor in this plan: it's ~70 measures with
time-signature changes, dynamics, and accidentals, and an anchor's whole
value depends on its ground truth being trustworthy — a transcription
error here would silently make a correct vision-read look wrong, or vice
versa. Adding it is separate follow-up work, either by someone
transcribing/verifying it directly or by a slower, explicitly-flagged
pass through the photo.
