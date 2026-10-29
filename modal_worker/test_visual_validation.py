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
import csv
import random
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import music21
from PIL import Image
import build_visual_validation_corpus as bvc
import degrade_visual_corpus as dvc
import validate_score_reading_against_corpus as vsrac

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    return ok


def _make_two_part_score_with_tempo_marks():
    """
    A tiny Score with 2 parts: the "real" line has 6 notes, the sparse
    artifact track has 2 notes, plus 3 MetronomeMark events on EACH part
    — mirroring exactly what was found on real MusicNet piece 2186 (1375
    vs 265 notes, both parts carrying the identical 66 tempo events).

    Described by ROLE, not by `score.parts` index, on purpose: the
    artifact part is inserted first but ends up at `score.parts[0]`
    (asserted below) — an earlier version of this docstring said "part
    0 has 6 notes (real), part 1 has 2 notes (artifact)", which was
    backwards relative to the actual insertion order in the code below.
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


def test_render_musicxml_to_pngs_produces_legible_nonempty_pages():
    print("\n[4] render_musicxml_to_pngs actually produces image files — "
          "a smoke test, not a pixel-content check (verovio+resvg-py's "
          "rendering fidelity was already confirmed by eye during "
          "spec-writing: /tmp/2186_page1_clean.png). This only proves "
          "the wiring (verovio load -> renderToSVG -> resvg_py "
          "svg_to_bytes -> file write) works end to end.")
    part = music21.stream.Part()
    part.append(music21.meter.TimeSignature('4/4'))
    for name in ["C4", "D4", "E4", "F4"]:
        part.append(music21.note.Note(name, quarterLength=1.0))
    measured = part.makeMeasures()

    with tempfile.TemporaryDirectory() as tmp:
        mxl_path = os.path.join(tmp, "test.musicxml")
        measured.write("musicxml", fp=mxl_path)
        out_prefix = os.path.join(tmp, "test")
        pngs = bvc.render_musicxml_to_pngs(mxl_path, out_prefix)

        check("at least one page rendered", len(pngs) >= 1, str(len(pngs)))
        for p in pngs:
            check(f"page file exists and is non-trivially sized: {os.path.basename(p)}",
                  os.path.exists(p) and os.path.getsize(p) > 1000,
                  f"{os.path.getsize(p) if os.path.exists(p) else 'MISSING'} bytes")


def test_render_musicxml_to_pngs_background_is_not_black():
    print("\n[4b] render_musicxml_to_pngs's output PNG has a real WHITE "
          "background, not solid black (final-review C2 fix). "
          "resvg_py.svg_to_bytes's raw output is RGBA with a fully "
          "transparent background whose underlying RGB is (0,0,0) — "
          "confirmed directly this session: before the fix, "
          "Image.open(...).convert('L') gave mean pixel value 0.0 on a "
          "real clean-tier page. read_score_notes_claude's own pipeline "
          "converts to 'L'/'RGB' with plain .convert(), which drops "
          "alpha without compositing, so every clean-tier page would "
          "have been read as blank black. This is the Minor finding "
          "the review elevated specifically because it's what would "
          "have caught C2.")
    part = music21.stream.Part()
    part.append(music21.meter.TimeSignature('4/4'))
    for name in ["C4", "D4", "E4", "F4"]:
        part.append(music21.note.Note(name, quarterLength=1.0))
    measured = part.makeMeasures()

    with tempfile.TemporaryDirectory() as tmp:
        mxl_path = os.path.join(tmp, "test.musicxml")
        measured.write("musicxml", fp=mxl_path)
        out_prefix = os.path.join(tmp, "test")
        pngs = bvc.render_musicxml_to_pngs(mxl_path, out_prefix)
        check("at least one page rendered", len(pngs) >= 1, str(len(pngs)))
        for p in pngs:
            gray = Image.open(p).convert("L")
            pixels = list(gray.getdata())
            max_val = max(pixels)
            check(f"page {os.path.basename(p)} is NOT all-black "
                  f"(max pixel value > 200, i.e. a real white background)",
                  max_val > 200, f"max pixel value {max_val}")


def test_build_corpus_entry_end_to_end_on_a_real_musicnet_piece():
    print("\n[5] build_corpus_entry runs the full Stage-1 pipeline on a "
          "REAL MusicNet piece (2191, the shortest solo-violin piece, "
          "539 notes) — part selection, tempo-mark stripping, "
          "makeMeasures, MusicXML write, rendering, and ground-truth "
          "extraction, in one call. This is the piece-level unit the "
          "corpus-build CLI (Task 4) loops over.")
    data_dir = os.environ.get(
        "VISUAL_VALIDATION_DATA_DIR",
        "/Users/matthewwu/.cache/mediant_validation/data")
    midi_path = os.path.join(data_dir, "midis", "2191.mid")
    if not os.path.exists(midi_path):
        check("SKIPPED (MusicNet corpus not present at " + data_dir + ")", True)
        return

    metadata_row = None
    with open(os.path.join(data_dir, "musicnet_metadata.csv")) as f:
        for row in csv.DictReader(f):
            if row["id"] == "2191":
                metadata_row = row
                break
    check("metadata row found for piece 2191", metadata_row is not None)

    with tempfile.TemporaryDirectory() as tmp:
        entry = bvc.build_corpus_entry("2191", midi_path, metadata_row, Path(tmp))
        check("entry was built (not None)", entry is not None)
        check("at least one measure extracted", len(entry["measures"]) > 0,
              str(len(entry.get("measures", []))))
        check("n_pages matches the number of rendered PNGs on disk",
              entry["n_pages"] == len(list(Path(tmp).glob("2191_page*.png"))),
              f"n_pages={entry['n_pages']}, files={list(Path(tmp).glob('2191_page*.png'))}")
        check("no measure has zero notes AND zero rests "
              "(a genuinely empty measure would signal a broken extraction)",
              all(len(m["notes"]) > 0 for m in entry["measures"]),
              str([m["number"] for m in entry["measures"] if not m["notes"]]))
        check("entry carries a time_signature string (final-review C1.1 fix)",
              isinstance(entry.get("time_signature"), str) and "/" in entry["time_signature"],
              str(entry.get("time_signature")))
        page1 = sorted(Path(tmp).glob("2191_page1.png"))
        check("page1.png's background is not solid black (final-review C2 fix)",
              bool(page1) and max(Image.open(page1[0]).convert("L").getdata()) > 200,
              str(max(Image.open(page1[0]).convert("L").getdata())) if page1 else "MISSING")


def _make_test_image():
    """A 200x200 white image with a black square in the top-left quadrant
    — enough asymmetry to detect rotation/warp/lighting effects by eye
    (via pixel sampling) without needing real sheet-music content."""
    img = Image.new("RGB", (200, 200), "white")
    for x in range(20, 80):
        for y in range(20, 80):
            img.putpixel((x, y), (0, 0, 0))
    return img


def test_rotate_no_exif_actually_rotates_the_pixels():
    print("\n[6] rotate_no_exif rotates the IMAGE CONTENT (not just an "
          "EXIF tag) — this is what makes the mild/severe tiers reproduce "
          "the real EXIF-orientation bug's failure shape: a page that is "
          "genuinely sideways in its pixel data, with no corrective tag "
          "to undo it, exactly like the real clarinet photo "
          "(real_photo_sideways_exif_portrait.jpg).")
    img = _make_test_image()
    rotated = dvc.rotate_no_exif(img, 90.0)
    # A 90-degree rotation of a top-left black square moves it toward the
    # top-right (PIL's rotate() is counter-clockwise by default).
    check("rotated image has no unexpected EXIF orientation tag",
          rotated.getexif().get(274) in (None, 1),
          str(rotated.getexif().get(274)))
    top_left_now_white = rotated.getpixel((40, 40)) == (255, 255, 255) \
        or sum(rotated.getpixel((40, 40))) > 600
    check("the black square is no longer in the top-left after a 90-degree rotation",
          top_left_now_white, str(rotated.getpixel((40, 40))))


def test_lighting_gradient_is_asymmetric():
    print("\n[7] lighting_gradient darkens one side and brightens the "
          "other — simulating a phone photo taken under an angled light "
          "or a lamp, not a uniform brightness shift (a uniform shift "
          "would not stress the pipeline's readability scoring the same "
          "way a real uneven-lighting photo does).")
    img = Image.new("RGB", (200, 200), (128, 128, 128))
    graded = dvc.lighting_gradient(img, dark_factor=0.5, light_factor=1.5)
    left = graded.getpixel((10, 100))
    right = graded.getpixel((190, 100))
    check("left and right edges differ in brightness",
          sum(left) != sum(right), f"left={left} right={right}")


def test_gaussian_blur_reduces_sharp_edges():
    print("\n[8] gaussian_blur actually softens a sharp edge (not a "
          "no-op) — simulating an out-of-focus phone photo.")
    img = _make_test_image()
    blurred = dvc.gaussian_blur(img, radius=3.0)
    # Sample a pixel right on the square's edge: sharp = pure black or
    # white, blurred = somewhere in between.
    edge_val = sum(blurred.getpixel((80, 50))) / 3
    check("the square's edge is no longer pure black or pure white",
          20 < edge_val < 235, str(edge_val))


def test_recompress_jpeg_changes_the_bytes():
    print("\n[9] recompress_jpeg actually re-encodes through JPEG "
          "(introducing real compression artifacts), not a pass-through.")
    img = _make_test_image()
    recompressed = dvc.recompress_jpeg(img, quality=60)
    check("recompressed image decodes to the same size",
          recompressed.size == img.size, str(recompressed.size))
    # JPEG is lossy even on a simple two-tone image at quality 60 — some
    # pixel must differ from the original. The artifacts land on the 8x8
    # blocks straddling the square's edge; blocks fully inside the flat
    # black interior encode exactly, so the drift check must scan the
    # whole image, not only the interior.
    drifted = any(recompressed.getpixel((x, y)) != img.getpixel((x, y))
                  for x in range(200) for y in range(200))
    check("JPEG compression introduced at least some pixel drift "
          "anywhere in the image", drifted)


def _count_differing_pixels(a, b):
    return sum(1 for x in range(a.size[0]) for y in range(a.size[1])
               if a.getpixel((x, y)) != b.getpixel((x, y)))


def test_perspective_warp_is_identity_at_zero_displacement():
    print("\n[10] perspective_warp with zero corner displacement is a "
          "(near-)identity transform. Guards the Image.QUAD corner-order "
          "bug: passing corners in TL/TR/BR/BL order produced a bow-tie "
          "distortion even at zero displacement. Small edge-interpolation "
          "differences are tolerated; a wrong corner order would change "
          "far more pixels than the tolerance allows.")
    # _make_test_image() is too symmetric to catch the corner-order bug (the
    # old TL/TR/BR/BL order maps its square back onto itself), so add a
    # red stripe in the top-right to make any corner mix-up visible.
    img = _make_test_image()
    for x in range(150, 200):
        for y in range(0, 20):
            img.putpixel((x, y), (255, 0, 0))
    warped = dvc.perspective_warp(img, corner_displacement_frac=0.0,
                                  rng=random.Random(1))
    mismatches = _count_differing_pixels(img, warped)
    tolerance = int(0.01 * img.size[0] * img.size[1])  # 1% of pixels
    check("zero-displacement warp matches input within 1% of pixels",
          mismatches <= tolerance,
          f"{mismatches} differing pixels (tolerance {tolerance})")


def test_perspective_warp_with_displacement_actually_moves_content():
    print("\n[11] perspective_warp with nonzero corner displacement "
          "actually changes the image (not a pass-through), using a seeded "
          "RNG so the result is deterministic.")
    img = _make_test_image()
    warped = dvc.perspective_warp(img, corner_displacement_frac=0.1,
                                  rng=random.Random(1))
    mismatches = _count_differing_pixels(img, warped)
    check("displaced warp output is not pixel-identical to the input",
          mismatches > 0, f"{mismatches} differing pixels")


def test_degrade_mild_and_severe_are_deterministic_given_a_seed():
    print("\n[10] degrade_mild/degrade_severe are fully deterministic "
          "given the same random.Random seed — so the degraded corpus "
          "is reproducible run to run, not a fresh random draw every "
          "time the CLI is invoked.")
    img = _make_test_image()
    out_a = dvc.degrade_mild(img.copy(), random.Random(42))
    out_b = dvc.degrade_mild(img.copy(), random.Random(42))
    check("same seed produces byte-identical mild output",
          list(out_a.getdata()) == list(out_b.getdata()))

    out_c = dvc.degrade_severe(img.copy(), random.Random(42))
    out_d = dvc.degrade_severe(img.copy(), random.Random(42))
    check("same seed produces byte-identical severe output",
          list(out_c.getdata()) == list(out_d.getdata()))

    out_e = dvc.degrade_mild(img.copy(), random.Random(43))
    check("a different seed produces different mild output",
          list(out_a.getdata()) != list(out_e.getdata()))


def test_score_measures_counts_exact_fingerprint_matches():
    print("\n[11] score_measures counts a measure as correct only when "
          "w._cross_source_measure_match (not w._measure_fingerprint — "
          "final-review C1 fix) says the predicted note list matches "
          "the ground truth's, under a 4/4 time signature where the two "
          "comparison functions happen to agree on plain, unspelled "
          "pitches.")
    ground_truth = [
        {"number": 1, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},
        {"number": 2, "notes": [{"pitch": "D4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},
        {"number": 3, "notes": [{"pitch": "E4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},
    ]
    predicted = [
        {"number": 1, "notes": [{"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},  # correct
        {"number": 2, "notes": [{"pitch": "D#4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},  # wrong pitch
        # measure 3 entirely missing from the predicted result
    ]
    n_correct, n_total = vsrac.score_measures(predicted, ground_truth, "4/4")
    check("1 of 3 ground-truth measures matched exactly",
          n_correct == 1 and n_total == 3, f"{n_correct}/{n_total}")


def test_score_measures_matches_across_pitch_spelling_conventions():
    print("\n[11b] score_measures matches a Claude-spelled 'Bb4' against "
          "a music21-spelled 'B-4' ground truth — same pitch, different "
          "spelling convention. This is exactly the case that was "
          "silently broken under the old w._measure_fingerprint "
          "comparison (raw-string equality: 'Bb4' != 'B-4', always), "
          "and is the regression final-review C1 fixes.")
    ground_truth = [
        {"number": 1, "notes": [{"pitch": "B-4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},
    ]
    predicted = [
        {"number": 1, "notes": [{"pitch": "Bb4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},
    ]
    # Sanity: prove the OLD comparison would have missed this (raw-string
    # fingerprints never equal across spelling conventions).
    check("w._measure_fingerprint on these two measures is NOT equal "
          "(proves the old comparison was broken for this exact case)",
          vsrac.w._measure_fingerprint(predicted[0]) != vsrac.w._measure_fingerprint(ground_truth[0]))
    n_correct, n_total = vsrac.score_measures(predicted, ground_truth, "4/4")
    check("'Bb4' matches 'B-4' under the new cross-source comparison",
          n_correct == 1 and n_total == 1, f"{n_correct}/{n_total}")


def test_score_measures_normalizes_compound_time_duration_units():
    print("\n[11c] score_measures matches a predicted note whose "
          "duration_beats is in NOTATED-BEAT units against a "
          "ground-truth note whose duration_beats is a quarterLength, "
          "once normalized by quarter_lengths_per_beat('6/8') — the "
          "compound-time duration-unit bug final-review C1 also fixes.")
    qlpb = vsrac.w.quarter_lengths_per_beat("6/8")
    check("quarter_lengths_per_beat('6/8') is 1.5 (one dotted-quarter beat)",
          qlpb == 1.5, str(qlpb))
    # A note that is 1 full notated beat long in 6/8 (Claude's unit) is
    # 1.5 quarterLengths (music21/ground-truth's unit) — known-correct
    # math: a 6/8 beat IS a dotted quarter, i.e. 1.5 quarterLengths.
    ground_truth = [
        {"number": 1, "notes": [{"pitch": "G4", "is_rest": False, "beat": 1.0, "duration_beats": 1.5}]},
    ]
    predicted = [
        {"number": 1, "notes": [{"pitch": "G4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]},
    ]
    n_correct, n_total = vsrac.score_measures(predicted, ground_truth, "6/8")
    check("1-notated-beat predicted duration matches 1.5-quarterLength "
          "ground truth once normalized for 6/8",
          n_correct == 1 and n_total == 1, f"{n_correct}/{n_total}")


def test_aggregate_scores_computes_per_piece_and_overall_percentages():
    print("\n[12] aggregate_scores rolls up per-piece (n_correct, "
          "n_total) pairs into % correct-measure-match per piece and "
          "overall — the same metric name/convention as the audio "
          "side's headline number.")
    per_piece = {
        "2191": (8, 10),
        "2204": (3, 10),
    }
    result = vsrac.aggregate_scores(per_piece)
    check("piece 2191 is 80%", result["per_piece"]["2191"] == 80.0, str(result["per_piece"]["2191"]))
    check("piece 2204 is 30%", result["per_piece"]["2204"] == 30.0, str(result["per_piece"]["2204"]))
    check("overall is 11/20 = 55%", result["overall"] == 55.0, str(result["overall"]))


def test_load_anchor_cases_finds_the_proof_of_mechanism_fixture():
    print("\n[13] load_anchor_cases discovers every subdirectory under "
          "visual_validation_anchors/ that has both a ground_truth.json "
          "and at least one page image, and loads them by name — the "
          "mechanism this plan commits to proving, even though the real "
          "clarinet-photo anchor's ground truth is explicitly deferred.")
    anchors_dir = Path(os.path.dirname(os.path.abspath(__file__))) / "visual_validation_anchors"
    anchors = vsrac.load_anchor_cases(anchors_dir)
    check("proof_of_mechanism anchor was discovered",
          "proof_of_mechanism" in anchors, str(list(anchors.keys())))
    entry = anchors["proof_of_mechanism"]
    check("it has at least one page image", len(entry["pages"]) >= 1, str(entry["pages"]))
    check("its ground truth has at least one measure",
          len(entry["ground_truth"]["measures"]) > 0,
          str(len(entry["ground_truth"].get("measures", []))))


def test_synthetic_piano_piece_builds_grand_staff_ground_truth():
    print("\n[47] a synthetic piano piece renders a 2-staff grand-staff score "
          "and extract_ground_truth_measures covers both staves' notes")
    import build_visual_validation_corpus as bvc
    from music21 import stream, note, meter, instrument as m21_instrument

    piano_part = stream.Part()
    piano_part.insert(0, m21_instrument.Piano())
    piano_part.append(meter.TimeSignature('4/4'))
    piano_part.append(note.Note('C4', quarterLength=1.0))
    piano_part.append(note.Note('E4', quarterLength=1.0))
    piano_part.append(note.Note('G4', quarterLength=1.0))
    piano_part.append(note.Note('C5', quarterLength=1.0))
    measured = piano_part.makeMeasures()

    # extract_ground_truth_measures returns a bare list of measure dicts
    # (annotated "-> list", confirmed by the existing test at line ~136
    # above: `measures[0]["notes"]`), NOT a dict with a "measures" key —
    # the brief's literal text assumed the latter; fixed here to match
    # the function's real, already-established contract.
    measures = bvc.extract_ground_truth_measures(measured)
    check("4 quarter notes in 4/4 produce exactly 1 measure",
          len(measures) == 1, str(measures))
    check("that measure has all 4 notes",
          len(measures[0]["notes"]) == 4,
          str(measures[0]))


def test_split_corpus_by_piece_is_deterministic_and_disjoint():
    print("\n[48] split_corpus_by_piece partitions piece IDs deterministically, "
          "disjointly, and covers every piece")
    import split_validation_corpus as svc

    fake_ground_truth = {f"piece{i}": {"measures": []} for i in range(10)}
    cal_a, held_a = svc.split_corpus_by_piece(fake_ground_truth, calibration_fraction=0.5, seed=42)
    cal_b, held_b = svc.split_corpus_by_piece(fake_ground_truth, calibration_fraction=0.5, seed=42)

    check("same seed produces the identical calibration set twice",
          cal_a == cal_b, f"{cal_a} vs {cal_b}")
    check("calibration and held-out sets are disjoint",
          cal_a.isdisjoint(held_a), f"{cal_a} & {held_a}")
    check("every piece ID is in exactly one of the two sets",
          cal_a | held_a == set(fake_ground_truth.keys()),
          f"union={cal_a | held_a} vs all={set(fake_ground_truth.keys())}")
    check("roughly half (5 of 10) went to calibration at fraction=0.5",
          len(cal_a) == 5, str(cal_a))


def test_real_ground_truth_json_has_instrument_backfilled_on_every_musicnet_piece():
    print("\n[49] after the real corpus rebuild, every pre-existing MusicNet "
          "piece in ground_truth.json has a correct 'instrument' field "
          "backfilled from MusicNet's own metadata (ensemble column), not "
          "just the new piano_synthetic entry — otherwise Task 3's required "
          "per-instrument accuracy breakdown would group 23/24 real pieces "
          "under 'unknown'.")
    import json
    INSTRUMENT_BY_PIECE_ID = {
        "2186": "Violin", "2191": "Violin", "2202": "Flute", "2203": "Flute",
        "2204": "Flute", "2217": "Cello", "2218": "Cello", "2219": "Cello",
        "2220": "Cello", "2221": "Cello", "2222": "Cello", "2241": "Violin",
        "2242": "Violin", "2243": "Violin", "2244": "Violin", "2288": "Violin",
        "2289": "Violin", "2293": "Cello", "2294": "Cello", "2295": "Cello",
        "2296": "Cello", "2297": "Cello", "2298": "Cello", "2659": "Violin",
    }
    gt_path = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/ground_truth.json")
    if not gt_path.exists():
        print("  SKIP  no local ground_truth.json cache found -- run Task 2 first")
        return
    gt = json.load(open(gt_path))
    for piece_id, expected_instrument in INSTRUMENT_BY_PIECE_ID.items():
        check(f"piece {piece_id} present in real ground_truth.json",
              piece_id in gt, str(list(gt.keys())[:5]))
        if piece_id in gt:
            check(f"piece {piece_id} instrument is {expected_instrument}",
                  gt[piece_id].get("instrument") == expected_instrument,
                  str(gt[piece_id].get("instrument")))


def main():
    print("=" * 70)
    print("Visual score-reading validation harness — ground truth tests")
    print("=" * 70)
    for t in (test_select_real_part_picks_the_part_with_more_notes,
              test_strip_tempo_marks_removes_every_metronome_mark,
              test_extract_ground_truth_measures_matches_the_fields_measure_fingerprint_compares,
              test_render_musicxml_to_pngs_produces_legible_nonempty_pages,
              test_render_musicxml_to_pngs_background_is_not_black,
              test_build_corpus_entry_end_to_end_on_a_real_musicnet_piece,
              test_rotate_no_exif_actually_rotates_the_pixels,
              test_lighting_gradient_is_asymmetric,
              test_gaussian_blur_reduces_sharp_edges,
              test_recompress_jpeg_changes_the_bytes,
              test_perspective_warp_is_identity_at_zero_displacement,
              test_perspective_warp_with_displacement_actually_moves_content,
              test_degrade_mild_and_severe_are_deterministic_given_a_seed,
              test_score_measures_counts_exact_fingerprint_matches,
              test_score_measures_matches_across_pitch_spelling_conventions,
              test_score_measures_normalizes_compound_time_duration_units,
              test_aggregate_scores_computes_per_piece_and_overall_percentages,
              test_load_anchor_cases_finds_the_proof_of_mechanism_fixture,
              test_synthetic_piano_piece_builds_grand_staff_ground_truth,
              test_split_corpus_by_piece_is_deterministic_and_disjoint,
              test_real_ground_truth_json_has_instrument_backfilled_on_every_musicnet_piece):
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
