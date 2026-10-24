"""
Ground-truth tests for the visual score-reading validation harness
(modal_worker/build_visual_validation_corpus.py, degrade_visual_corpus.py,
validate_score_reading_against_corpus.py).

Run:  python3 modal_worker/test_visual_validation.py

Unlike test_analysis.py, this file does NOT stub music21/numpy/Pillow —
it requires the real packages (music21==9.1.0, verovio==6.3.0,
resvg-py==0.5.0, Pillow==13.0.0, numpy==1.26.4), the same way
validate_alignment_against_musicnet.py requires the real torch/torchcrepe
stack. Run it inside the dedicated validation venv:

  source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
  python3 modal_worker/test_visual_validation.py

See docs/superpowers/specs/2026-10-23-visual-score-reading-validation-harness-design.md
for why this corpus/approach exists.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import music21
import build_visual_validation_corpus as bvc

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    return ok


def _make_two_part_score_with_tempo_marks():
    """
    A tiny Score with 2 parts: part 0 has 6 notes (the "real" line), part 1
    has 2 notes (a sparse artifact track) plus 3 MetronomeMark events on
    EACH part — mirroring exactly what was found on real MusicNet piece
    2186 (1375 vs 265 notes, both parts carrying the identical 66 tempo
    events).
    """
    score = music21.stream.Score()

    real_part = music21.stream.Part()
    real_part.append(music21.meter.TimeSignature('4/4'))
    for name in ["C4", "D4", "E4", "F4", "G4", "A4"]:
        real_part.append(music21.note.Note(name, quarterLength=1.0))
    for beat_offset, bpm in [(0.0, 120), (2.0, 110), (4.0, 100)]:
        mm = music21.tempo.MetronomeMark(number=bpm)
        real_part.insert(beat_offset, mm)

    artifact_part = music21.stream.Part()
    artifact_part.append(music21.meter.TimeSignature('4/4'))
    artifact_part.append(music21.note.Note("C2", quarterLength=2.0))
    artifact_part.append(music21.note.Note("C2", quarterLength=2.0))
    for beat_offset, bpm in [(0.0, 120), (2.0, 110), (4.0, 100)]:
        mm = music21.tempo.MetronomeMark(number=bpm)
        artifact_part.insert(beat_offset, mm)

    score.insert(0, artifact_part)
    score.insert(0, real_part)
    # Precondition: the artifact part must sit at parts[0], otherwise the
    # selection test below would pass even for a buggy "return parts[0]"
    # implementation and guard nothing.
    assert score.parts[0] is artifact_part, \
        "fixture must put the artifact part first, or this test doesn't guard anything"
    return score, real_part, artifact_part


def test_select_real_part_picks_the_part_with_more_notes():
    print("\n[1] select_real_part picks the part with dramatically more "
          "notes, matching the pattern confirmed on all 24 real MusicNet "
          "pieces (one dominant part, the rest are MIDI-encoding "
          "artifacts) — never the first part by position.")
    score, real_part, artifact_part = _make_two_part_score_with_tempo_marks()
    # Insert the artifact part FIRST in the score's parts ordering, so a
    # bug that just picks score.parts[0] would wrongly select it.
    picked = bvc.select_real_part(score)
    check("picks the 6-note part, not the 2-note part",
          picked is real_part, f"picked {len(list(picked.flatten().notes))}-note part")


def test_strip_tempo_marks_removes_every_metronome_mark():
    print("\n[2] strip_tempo_marks removes ALL MetronomeMark elements from "
          "a part, not just the first — reproducing the fix that turned "
          "piece 2186's page from a second staff cluttered with ~66 tempo "
          "boxes into a clean single staff.")
    score, real_part, artifact_part = _make_two_part_score_with_tempo_marks()
    before = len(list(real_part.flatten().getElementsByClass('MetronomeMark')))
    check("fixture actually has tempo marks before stripping", before == 3, str(before))
    bvc.strip_tempo_marks(real_part)
    after = len(list(real_part.flatten().getElementsByClass('MetronomeMark')))
    check("zero tempo marks remain after stripping", after == 0, str(after))
    notes_after = len(list(real_part.flatten().notes))
    check("stripping tempo marks does not remove any actual notes",
          notes_after == 6, str(notes_after))


def _make_measured_part_with_a_rest_and_an_accidental():
    """2 measures in 4/4: measure 1 has a rest then 3 quarter notes
    (one with a sharp), measure 2 has a single whole note."""
    part = music21.stream.Part()
    part.append(music21.meter.TimeSignature('4/4'))
    part.append(music21.note.Rest(quarterLength=1.0))
    part.append(music21.note.Note("C4", quarterLength=1.0))
    part.append(music21.note.Note("F#4", quarterLength=1.0))
    part.append(music21.note.Note("G4", quarterLength=1.0))
    part.append(music21.note.Note("D5", quarterLength=4.0))
    return part.makeMeasures()


def test_extract_ground_truth_measures_matches_the_fields_measure_fingerprint_compares():
    print("\n[3] extract_ground_truth_measures produces the 4 fields "
          "(pitch/is_rest/beat/duration_beats) that worker.py's "
          "_measure_fingerprint compares, using the same encoding "
          "parse_musicxml uses (pitch as nameWithOctave or None for a rest). "
          "It is not a full copy of parse_musicxml's richer note dict. "
          "Sharp spelling ('F#4', not 'Gb4') must survive untouched, "
          "matching music21's own nameWithOctave convention.")
    measured = _make_measured_part_with_a_rest_and_an_accidental()
    measures = bvc.extract_ground_truth_measures(measured)

    check("two measures extracted", len(measures) == 2, str(len(measures)))
    m1, m2 = measures[0], measures[1]
    check("measure numbers are 1 and 2",
          m1["number"] == 1 and m2["number"] == 2,
          f"{m1['number']}, {m2['number']}")

    check("measure 1 has 4 note/rest entries", len(m1["notes"]) == 4, str(len(m1["notes"])))
    rest, c4, fs4, g4 = m1["notes"]
    check("rest entry: is_rest True, pitch None, beat 1.0",
          rest["is_rest"] is True and rest["pitch"] is None and rest["beat"] == 1.0,
          str(rest))
    check("sharp spelling preserved exactly ('F#4')",
          fs4["pitch"] == "F#4", fs4["pitch"])
    check("duration_beats is the music21 quarterLength, not beat-scaled",
          c4["duration_beats"] == 1.0, str(c4["duration_beats"]))
    check("beat positions are 1-indexed within the measure",
          rest["beat"] == 1.0 and c4["beat"] == 2.0 and fs4["beat"] == 3.0 and g4["beat"] == 4.0,
          f"{[n['beat'] for n in m1['notes']]}")

    check("measure 2 has 1 note entry (the whole note)",
          len(m2["notes"]) == 1, str(len(m2["notes"])))
    check("whole note duration_beats is 4.0",
          m2["notes"][0]["duration_beats"] == 4.0, str(m2["notes"][0]["duration_beats"]))


def main():
    print("=" * 70)
    print("Visual score-reading validation harness — ground truth tests")
    print("=" * 70)
    for t in (test_select_real_part_picks_the_part_with_more_notes,
              test_strip_tempo_marks_removes_every_metronome_mark,
              test_extract_ground_truth_measures_matches_the_fields_measure_fingerprint_compares):
        try:
            t()
        except Exception as e:                                  # noqa: BLE001
            import traceback
            RESULTS.append((t.__name__, False, f"{type(e).__name__}: {e}"))
            print(f"  ERROR {t.__name__}: {type(e).__name__}: {e}")
            traceback.print_exc()
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print("\n" + "=" * 70)
    print(f"{passed}/{len(RESULTS)} checks passed")
    failed = [(n, d) for n, ok, d in RESULTS if not ok]
    for n, d in failed:
        print(f"  FAILED: {n}  {d}")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
