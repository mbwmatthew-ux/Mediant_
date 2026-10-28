"""
Tests for smt_inference.py. Per Task 3 Step 1, these assume the real SMT
API confirmed by direct experiment -- update the fake/mock in this file to
match whatever Step 1 actually found, not this plan's guess, if they differ.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smt_inference as si

RESULTS = []


def check(desc, passed, detail=""):
    RESULTS.append(passed)
    print(f"  {'PASS' if passed else 'FAIL'}  {desc}" + (f"   {detail}" if detail else ""))


def test_transcribe_with_smt_returns_measures_shape():
    print("\n[1] transcribe_with_smt returns the same {measures, source} shape "
          "read_score_notes_claude returns, so existing scoring code works unmodified")
    from pathlib import Path
    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
    page_paths = sorted(corpus_dir.glob("2204_page*.png"))
    if not page_paths:
        print("  SKIP  no corpus page found at the expected path -- run Task 2 first")
        return
    result = si.transcribe_with_smt(page_paths, checkpoint="antoniorv6/smt-grandstaff")
    check("result has a 'measures' key", "measures" in result, str(result)[:300])
    check("result['source'] is 'smt'", result.get("source") == "smt", str(result.get("source")))


def test_decode_smt_output_real_observed_header_shape():
    print("\n[2] _decode_smt_output handles the REAL observed Step 1 output "
          "(header-only, zero notes) without raising, returning [] measures")
    # Verbatim real text_sequence captured in Step 1 against
    # visual_corpus/clean/2204_page1.png (see smt_inference.py's module
    # docstring, point 7) -- the model emitted <eos> right after the
    # kern header, before any measure content.
    real_header_only_output = [
        '**ekern_1.0', '<t>', '**ekern_1.0', '<b>', '*clefF4', '<t>',
        '*clefG2', '<b>', '*k[]', '<t>', '*k[]', '<b>', '*M3/4', '<t>',
        '*M3/4', '<b>', '=-', '<t>', '=-', '<b>', '*-', '<t>', '*-',
        '<b>', '', '<b>', '',
    ]
    measures = si._decode_smt_output(real_header_only_output)
    check("does not raise on real header-only output", True)
    check("every returned measure has an empty notes list "
          "(the real run never emitted a note token)",
          all(not m["notes"] for m in measures), str(measures))


def test_decode_smt_output_parses_a_real_vocabulary_note_atom():
    print("\n[3] _decode_smt_output correctly parses a note atom built from "
          "this checkpoint's own real, loaded vocabulary string (model.i2w "
          "id 2, confirmed in Step 1) inside one synthetic but "
          "grammar-real measure")
    # '8F#L>' is real vocab id 2 -- confirmed directly against the live
    # model's own i2w table (Step 1), not an invented string. Single
    # uppercase letter = octave 3 in kern's case+repetition convention
    # (confirmed via the real PRAIG/grandstaff-ekern ground-truth sample,
    # see smt_inference.py's module docstring point 9: bass-clef "F" sits
    # in F3's register). '<t>'/'<b>'/'<s>' are the real confirmed
    # separator tokens.
    tokens = [
        '*clefG2', '<b>',
        '8F#L>', '<b>',
        '=', '<b>',
    ]
    measures = si._decode_smt_output(tokens)
    check("produced exactly one measure", len(measures) == 1, str(measures))
    if measures:
        notes = measures[0]["notes"]
        check("parsed the one real note atom '8F#L>' as F#3, not a rest",
              len(notes) == 1 and notes[0]["pitch"] == "F#3" and not notes[0]["is_rest"],
              str(notes))


def test_decode_smt_output_incipit_marker_is_not_a_measure_boundary():
    print("\n[4] _decode_smt_output does not treat bekern's '=-' data-start "
          "incipit marker (real Step 1 output: it appears right after the "
          "time-signature tokens, before any content) as a measure "
          "boundary -- real content that follows it must land on measure "
          "1, not measure 2 (review fix)")
    # '=-' (incipit, no-op) -> '8F#L>' (real note, real vocab id 2) ->
    # '=' (the first REAL barline, closing measure 1).
    tokens = ['*clefG2', '<b>', '=-', '<b>', '8F#L>', '<b>', '=', '<b>']
    measures = si._decode_smt_output(tokens)
    check("produced exactly one measure (not two)", len(measures) == 1, str(measures))
    if measures:
        check("the real note landed on measure number 1",
              measures[0]["number"] == 1, str(measures[0]["number"]))
        check("the real note's pitch survived ('=-' consumed nothing)",
              measures[0]["notes"] and measures[0]["notes"][0]["pitch"] == "F#3",
              str(measures[0]["notes"]))


def test_quarter_lengths_per_beat_local_matches_worker_for_compound_meter():
    print("\n[5] _quarter_lengths_per_beat_local('6/8') matches the real "
          "worker.quarter_lengths_per_beat exactly (1.5, a dotted-quarter "
          "beat) -- review fix: this value feeds every predicted note's "
          "beat/duration under exact-equality scoring, so a factor-of-2 "
          "arithmetic error here would silently fail every correct "
          "compound-meter transcription")
    qlpb_6_8 = si._quarter_lengths_per_beat_local("6/8")
    check("6/8 -> 1.5 (not 0.75)", qlpb_6_8 == 1.5, str(qlpb_6_8))
    qlpb_6_4 = si._quarter_lengths_per_beat_local("6/4")
    check("6/4 -> 1.0 (simple meter, denom < 8, not misclassified as compound)",
          qlpb_6_4 == 1.0, str(qlpb_6_4))
    qlpb_4_4 = si._quarter_lengths_per_beat_local("4/4")
    check("4/4 -> 1.0 (unaffected, sanity check)", qlpb_4_4 == 1.0, str(qlpb_4_4))


def main():
    test_transcribe_with_smt_returns_measures_shape()
    test_decode_smt_output_real_observed_header_shape()
    test_decode_smt_output_parses_a_real_vocabulary_note_atom()
    test_decode_smt_output_incipit_marker_is_not_a_measure_boundary()
    test_quarter_lengths_per_beat_local_matches_worker_for_compound_meter()
    passed = sum(1 for r in RESULTS if r)
    total = len(RESULTS)
    print(f"\n{'='*70}\n{passed}/{total} checks passed\n{'='*70}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
