"""
Ground-truth tests for modal_worker/page_omr_adapter.py — the staging-only
page-omr+deskew score-reading engine (see "MEDIANT — Integrate page-omr +
Deskew Into Staging", 2026-10-31).

Run:  python3 modal_worker/test_page_omr_adapter.py

Does NOT load the real page-omr model/checkpoint (that lives in a separate
isolated venv — see agent_workspace/PAGE_OMR_*.md for where it was
validated). Tests here cover the pure-Python logic this module owns:
kern-to-canonical-measure conversion (including the measure-renumbering
fix) and the page_omr_adapter.score_pages_with_page_omr orchestration,
driven by monkeypatching run_inference/deskew_image/_ensure_model_loaded
rather than running real inference.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import page_omr_adapter as poa  # noqa: E402

RESULTS = []


def check(desc, condition, detail=""):
    RESULTS.append((desc, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    print(f"  {status}  {desc}" + (f"   {detail}" if detail and not condition else ""))


# A real page-omr-shaped kern snippet (bare "=" barlines, no explicit
# measure numbers) — the exact shape that caused the measure-numbering
# bug documented in agent_workspace/PAGE_OMR_BENCHMARK_FINDINGS.md: without
# the renumbering fix, music21's humdrum reader leaves every measure after
# the first at measure.number == 0, collapsing them onto one dict key.
_VALID_KERN = """**kern
*staff1
*clefG2
*k[]
*M4/4
=
4c
4e
4g
4cc
=
4b
4g
4e
4c
*-
"""


# The following 3 kern fixtures are EXACT, VERBATIM raw output captured
# from the real page-omr model running against real rendered pages of
# synthetic music21 fixtures with known ground truth -- not hand-crafted
# guesses at Humdrum syntax. Captured while investigating "MEDIANT --
# Implement Multi-Voice Score Preservation" Task 1 (boundary A: does the
# OMR model itself ever emit multi-part/multi-voice kern). Confirmed: it
# does, correctly, for both shapes below. The data loss was entirely in
# kern_to_measures's OWN extraction (boundary C: parts[0]-only, and
# measure.notesAndRests never recursing into Voice sub-streams).

# Ground truth: one staff, two independent simultaneous voices -- voice 1
# plays C5,D5,E5,F5 (quarter notes), voice 2 plays C4,G3 (half notes).
_TWO_VOICE_KERN = """**kern
*staff1
*clefG2
*k[]
*M4/4
=
*^
4cc	2c
4dd	.
4ee	2G
4ff	.
*v	*v
=
*-
"""

# Ground truth: two staves (grand staff) -- treble C5,D5,E5,F5 (quarter
# notes), bass C3,G2 (half notes).
_TWO_STAFF_KERN = """**kern\t**kern
*staff2\t*staff1
*clefF4\t*clefG2
*k[]\t*k[]
*M4/4\t*M4/4
=\t=
2C\t4cc
.\t4dd
2GG\t4ee
.\t4ff
==\t==
*-\t*-
"""

# Hand-written (standard Humdrum tie notation: "[" starts a tie, "]" ends
# it) -- a single F4 of total duration 2 quarter notes, tied across the
# barline between measure 1 and measure 2.
_TIED_NOTE_KERN = """**kern
*staff1
*clefG2
*k[]
*M4/4
=1
4c
4d
4e
[4f
=2
4f]
4g
4a
4b
*-
"""


def test_kern_to_measures_fixes_the_zero_numbering_bug():
    print("\n[1] kern_to_measures renumbers 1..N by reading-order position — "
          "without this fix, every measure after the first collapses onto "
          "measure.number == 0 (music21's humdrum reader leaves bare '=' "
          "barlines unnumbered), discarding real content before scoring "
          "or canonicalization ever sees it.")
    measures, err = poa.kern_to_measures(_VALID_KERN)
    check("no parse error", err is None, str(err))
    check("exactly 2 measures (not collapsed onto one)", len(measures) == 2, str(measures))
    if len(measures) == 2:
        check("measure numbers are 1, 2 (not 0, 0)",
              [m["number"] for m in measures] == [1, 2], str([m["number"] for m in measures]))
        check("measure 1 has 4 notes", len(measures[0]["notes"]) == 4, str(measures[0]))
        check("measure 1 note 1 is C4, not a rest",
              measures[0]["notes"][0]["pitch"] == "C4" and measures[0]["notes"][0]["is_rest"] is False,
              str(measures[0]["notes"][0]))


def test_kern_to_measures_reports_unparseable_output_as_an_error_not_a_crash():
    print("\n[2] garbage model output returns ([], error) rather than raising — "
          "a real transcription failure must become a structured error the "
          "caller can act on, not an unhandled exception that takes down "
          "the whole analysis request.")
    measures, err = poa.kern_to_measures("this is not kern notation at all {{{")
    check("empty measures on unparseable input", measures == [], str(measures))
    check("error is a non-empty string naming what went wrong",
          isinstance(err, str) and len(err) > 0, str(err))


def test_collapse_ratio_empty_string_is_zero():
    print("\n[3] collapse_ratio of empty/falsy input is 0.0, not a divide-by-zero")
    check("empty string -> 0.0", poa.collapse_ratio("") == 0.0)


def _patch(monkeypatch_target, name, fn):
    orig = getattr(monkeypatch_target, name)
    setattr(monkeypatch_target, name, fn)
    return orig


def test_score_pages_with_page_omr_concatenates_and_renumbers_across_pages():
    print("\n[4] score_pages_with_page_omr renumbers sequentially ACROSS "
          "pages, continuing from start_measure, and tags each measure with "
          "its source page — production has no ground-truth page mapping "
          "(unlike the offline benchmark's verovio-derived one), so simple "
          "in-order concatenation is the only thing available.")
    orig_ensure = poa._ensure_model_loaded
    orig_decode = poa._bytes_to_image
    orig_deskew = poa.deskew_image
    orig_infer = poa.run_inference
    orig_ratio = poa.collapse_ratio
    try:
        poa._ensure_model_loaded = lambda: None
        poa._bytes_to_image = lambda b, m: object()
        poa.deskew_image = lambda img: (img, 0.0)
        poa.collapse_ratio = lambda raw: 0.0  # real detect_repetition_loops needs the omr package
        # Page 1 -> 2 measures, page 2 -> 1 measure, by returning the kern
        # text keyed to a call counter.
        calls = {"n": 0}
        def fake_infer(img):
            calls["n"] += 1
            if calls["n"] == 1:
                return _VALID_KERN, 1.0
            return "**kern\n*staff1\n*clefG2\n*k[]\n*M4/4\n=\n4c\n*-\n", 1.0
        poa.run_inference = fake_infer

        result = poa.score_pages_with_page_omr([(b"page1", "image/png"), (b"page2", "image/png")], start_measure=5)
    finally:
        poa._ensure_model_loaded = orig_ensure
        poa._bytes_to_image = orig_decode
        poa.deskew_image = orig_deskew
        poa.run_inference = orig_infer
        poa.collapse_ratio = orig_ratio

    check("no top-level error", "error" not in result, str(result))
    check("source is page_omr", result.get("source") == "page_omr", str(result))
    nums = [m["number"] for m in result["measures"]]
    check("numbering continues 5,6,7 across both pages (2 from page 1, 1 from page 2)",
          nums == [5, 6, 7], str(nums))
    pages = [m["page"] for m in result["measures"]]
    check("page tags match source page (1,1,2)", pages == [1, 1, 2], str(pages))


def test_score_pages_with_page_omr_all_pages_fail_returns_structured_error():
    print("\n[5] every page failing (e.g. every inference call raises) "
          "returns measures=[] with a non-empty 'error' string naming "
          "every page's failure, never a silently-empty success result.")
    orig_ensure = poa._ensure_model_loaded
    orig_decode = poa._bytes_to_image
    orig_deskew = poa.deskew_image
    orig_infer = poa.run_inference
    try:
        poa._ensure_model_loaded = lambda: None
        poa._bytes_to_image = lambda b, m: object()
        poa.deskew_image = lambda img: (img, 0.0)
        def failing_infer(img):
            raise RuntimeError("model exploded")
        poa.run_inference = failing_infer

        result = poa.score_pages_with_page_omr([(b"page1", "image/png")], start_measure=1)
    finally:
        poa._ensure_model_loaded = orig_ensure
        poa._bytes_to_image = orig_decode
        poa.deskew_image = orig_deskew
        poa.run_inference = orig_infer

    check("measures is empty", result.get("measures") == [], str(result))
    check("error names the failure", "error" in result and "model exploded" in result["error"], str(result))


def test_score_pages_with_page_omr_partial_failure_keeps_good_pages_and_flags_bad_ones():
    print("\n[6] one good page + one page whose output collapses into "
          "degenerate repetition (ratio above the validated threshold) "
          "returns the GOOD page's measures plus a non-empty "
          "'partial_error' naming the bad one — never silently drops a "
          "working page's data, and never silently hides the failure either.")
    orig_ensure = poa._ensure_model_loaded
    orig_decode = poa._bytes_to_image
    orig_deskew = poa.deskew_image
    orig_infer = poa.run_inference
    orig_ratio = poa.collapse_ratio
    try:
        poa._ensure_model_loaded = lambda: None
        poa._bytes_to_image = lambda b, m: object()
        poa.deskew_image = lambda img: (img, 0.0)
        calls = {"n": 0}
        def fake_infer(img):
            calls["n"] += 1
            if calls["n"] == 1:
                return _VALID_KERN, 1.0
            return "degenerate-repeated-output", 1.0
        poa.run_inference = fake_infer
        # First page's output is real, valid kern (low ratio); second
        # page's is forced to look degenerate (ratio above the validated
        # threshold) — forced directly rather than crafting a real
        # repeating kern string, to isolate the orchestration logic under
        # test from detect_repetition_loops' own behavior.
        poa.collapse_ratio = lambda raw: 0.0 if raw == _VALID_KERN else 0.9

        result = poa.score_pages_with_page_omr(
            [(b"page1", "image/png"), (b"page2", "image/png")], start_measure=1)
    finally:
        poa._ensure_model_loaded = orig_ensure
        poa._bytes_to_image = orig_decode
        poa.deskew_image = orig_deskew
        poa.run_inference = orig_infer
        poa.collapse_ratio = orig_ratio

    check("no top-level error — page 1's measures are still returned",
          "error" not in result and result.get("measures"), str(result))
    check("partial_error mentions the degenerate page",
          "partial_error" in result and "page 2" in result["partial_error"], str(result))


def test_score_pages_with_page_omr_exposes_page_kern_and_failed_pages():
    print("\n[7] score_pages_with_page_omr exposes page_kern (per-page raw "
          "kern, keyed by page index) for every page that contributed "
          "measures, and failed_pages (structured, not just embedded in a "
          "string) for every page that did not — the multi-page V2 caller "
          "needs page_kern to build one combined note_array without "
          "re-running inference, and failed_pages to identify exactly "
          "which page(s) to tell the uploader about.")
    orig_ensure = poa._ensure_model_loaded
    orig_decode = poa._bytes_to_image
    orig_deskew = poa.deskew_image
    orig_infer = poa.run_inference
    orig_ratio = poa.collapse_ratio
    try:
        poa._ensure_model_loaded = lambda: None
        poa._bytes_to_image = lambda b, m: object()
        poa.deskew_image = lambda img: (img, 0.0)
        poa.collapse_ratio = lambda raw: 0.0 if raw == _VALID_KERN else 0.9
        # Page 1 and 3 succeed (valid kern); page 2 is forced degenerate.
        calls = {"n": 0}
        def fake_infer(img):
            calls["n"] += 1
            return (_VALID_KERN, 1.0) if calls["n"] != 2 else ("bad-output", 1.0)
        poa.run_inference = fake_infer

        result = poa.score_pages_with_page_omr(
            [(b"p1", "image/png"), (b"p2", "image/png"), (b"p3", "image/png")],
            start_measure=1)
    finally:
        poa._ensure_model_loaded = orig_ensure
        poa._bytes_to_image = orig_decode
        poa.deskew_image = orig_deskew
        poa.run_inference = orig_infer
        poa.collapse_ratio = orig_ratio

    page_kern = result.get("page_kern") or {}
    check("page_kern has entries for pages 1 and 3 only",
          set(page_kern.keys()) == {1, 3}, str(page_kern))
    check("page_kern values are the raw kern text",
          page_kern.get(1) == _VALID_KERN and page_kern.get(3) == _VALID_KERN,
          str(page_kern))
    check("failed_pages lists page 2 only",
          result.get("failed_pages") == [2], str(result.get("failed_pages")))


def test_score_pages_with_page_omr_detects_duplicate_page_upload():
    print("\n[8] two pages that produce byte-identical recognition output "
          "(e.g. the same photo uploaded twice) are flagged via "
          "duplicate_page_warning — a diagnostic, not a failure; both "
          "pages' measures are still included in the result.")
    orig_ensure = poa._ensure_model_loaded
    orig_decode = poa._bytes_to_image
    orig_deskew = poa.deskew_image
    orig_infer = poa.run_inference
    orig_ratio = poa.collapse_ratio
    try:
        poa._ensure_model_loaded = lambda: None
        poa._bytes_to_image = lambda b, m: object()
        poa.deskew_image = lambda img: (img, 0.0)
        poa.collapse_ratio = lambda raw: 0.0
        poa.run_inference = lambda img: (_VALID_KERN, 1.0)  # identical every call

        result = poa.score_pages_with_page_omr(
            [(b"p1", "image/png"), (b"p2", "image/png")], start_measure=1)
    finally:
        poa._ensure_model_loaded = orig_ensure
        poa._bytes_to_image = orig_decode
        poa.deskew_image = orig_deskew
        poa.run_inference = orig_infer
        poa.collapse_ratio = orig_ratio

    check("duplicate_page_warning set and names both pages",
          result.get("duplicate_page_warning")
          and "page 1" in result["duplicate_page_warning"]
          and "page 2" in result["duplicate_page_warning"],
          str(result.get("duplicate_page_warning")))
    check("both pages' measures are still present (diagnostic, not a drop)",
          len(result["measures"]) == 4, str(result["measures"]))


def test_case_a_single_melody_unchanged_part_and_voice_default_to_backward_compatible_values():
    print("\n[9] Case A -- single melody, existing behavior unchanged: every "
          "note still carries pitch/is_rest/beat/duration_beats exactly as "
          "before, with the new part/voice/tied fields present but at "
          "backward-compatible defaults (part=0, voice=None, tied=None) "
          "for a plain single-voice, single-part score.")
    measures, err = poa.kern_to_measures(_VALID_KERN)
    check("no parse error", err is None, str(err))
    check("exactly 2 measures", len(measures) == 2, str(measures))
    check("every note has part=0, voice=None, tied=None",
          all(n.get("part") == 0 and n.get("voice") is None and n.get("tied") is None
              for m in measures for n in m["notes"]),
          str(measures))
    if len(measures) == 2:
        check("measure 1 has 4 notes", len(measures[0]["notes"]) == 4, str(measures[0]))
        check("pitches unchanged: C4 E4 G4 C5 / B4 G4 E4 C4",
              [n["pitch"] for n in measures[0]["notes"]] == ["C4", "E4", "G4", "C5"]
              and [n["pitch"] for n in measures[1]["notes"]] == ["B4", "G4", "E4", "C4"],
              str(measures))


def test_case_b_two_simultaneous_independent_voices_both_fully_preserved():
    print("\n[10] Case B -- one staff, two simultaneous independent voices "
          "(real page-omr output, Humdrum spine-split *^/*v): both voices' "
          "notes survive, tagged with distinct voice identifiers, with "
          "correct overlapping onset times and durations -- neither voice "
          "is dropped and neither is merged into a flattened melody.")
    measures, err = poa.kern_to_measures(_TWO_VOICE_KERN)
    check("no parse error", err is None, str(err))
    check("exactly 1 measure", len(measures) == 1, str(measures))
    notes = measures[0]["notes"] if measures else []
    check("exactly 6 note events (4 in voice 0 + 2 in voice 1), none dropped, none duplicated",
          len(notes) == 6, str(notes))
    voice0 = [n for n in notes if n.get("voice") == 0]
    voice1 = [n for n in notes if n.get("voice") == 1]
    check("voice 0 has the 4 quarter notes C5 D5 E5 F5 at beats 1,2,3,4",
          [n["pitch"] for n in voice0] == ["C5", "D5", "E5", "F5"]
          and [n["beat"] for n in voice0] == [1.0, 2.0, 3.0, 4.0]
          and all(n["duration_beats"] == 1.0 for n in voice0),
          str(voice0))
    check("voice 1 has the 2 half notes C4 G3 at beats 1,3 -- overlapping voice 0's timing, not sequential after it",
          [n["pitch"] for n in voice1] == ["C4", "G3"]
          and [n["beat"] for n in voice1] == [1.0, 3.0]
          and all(n["duration_beats"] == 2.0 for n in voice1),
          str(voice1))
    check("both voices tagged part=0 (same staff)",
          all(n.get("part") == 0 for n in notes), str(notes))


def test_case_c_chord_pitches_preserved_as_separate_events_not_merged_or_dropped():
    print("\n[11] Case C -- a chord at one onset: every pitch in the chord "
          "becomes its own note event at the same beat/duration, and a "
          "following rest is preserved too (regression guard: this path "
          "already worked before this round's change).")
    chord_kern = "**kern\n*staff1\n*clefG2\n*k[]\n*M4/4\n=\n4c 4e 4g\n4r\n4r\n4r\n*-\n"
    measures, err = poa.kern_to_measures(chord_kern)
    check("no parse error", err is None, str(err))
    notes = measures[0]["notes"] if measures else []
    check("3 chord pitches + 3 rests (duration-complete 4/4 measure) = 6 events, none duplicated/dropped",
          len(notes) == 6, str(notes))
    pitched = [n for n in notes if not n["is_rest"]]
    rests = [n for n in notes if n["is_rest"]]
    check("chord pitches are C4, E4, G4 at the same beat/duration",
          {n["pitch"] for n in pitched} == {"C4", "E4", "G4"}
          and all(n["beat"] == 1.0 and n["duration_beats"] == 1.0 for n in pitched),
          str(pitched))
    check("all 3 rests are preserved (is_rest=True, pitch=None)",
          len(rests) == 3 and all(n["pitch"] is None for n in rests), str(rests))


def test_case_d_two_independent_parts_both_fully_preserved():
    print("\n[12] Case D -- two independent parts/staves (real page-omr "
          "output, parallel **kern spines): both staves' notes survive, "
          "tagged with distinct part indices -- the second staff is no "
          "longer silently discarded by a parts[0]-only read.")
    measures, err = poa.kern_to_measures(_TWO_STAFF_KERN)
    check("no parse error", err is None, str(err))
    check("exactly 1 measure", len(measures) == 1, str(measures))
    notes = measures[0]["notes"] if measures else []
    check("exactly 6 note events (4 treble + 2 bass), none dropped",
          len(notes) == 6, str(notes))
    part0 = [n for n in notes if n.get("part") == 0]
    part1 = [n for n in notes if n.get("part") == 1]
    check("part 0 (treble) has C5 D5 E5 F5 quarter notes",
          [n["pitch"] for n in part0] == ["C5", "D5", "E5", "F5"], str(part0))
    check("part 1 (bass) has C3 G2 half notes -- the staff a parts[0]-only "
          "read used to discard entirely",
          [n["pitch"] for n in part1] == ["C3", "G2"]
          and all(n["duration_beats"] == 2.0 for n in part1),
          str(part1))


def test_case_e_two_page_continuation_preserves_voices_and_continuous_numbering():
    print("\n[13] Case E -- two-page continuation with multiple voices: "
          "score_pages_with_page_omr must keep BOTH voices from EACH page, "
          "continuously and correctly numbered across the page boundary -- "
          "proving multi-page concatenation (prior round) and multi-voice "
          "preservation (this round) compose correctly together.")
    orig_ensure, orig_decode, orig_deskew, orig_infer, orig_ratio = (
        poa._ensure_model_loaded, poa._bytes_to_image, poa.deskew_image,
        poa.run_inference, poa.collapse_ratio)
    try:
        poa._ensure_model_loaded = lambda: None
        poa._bytes_to_image = lambda b, m: object()
        poa.deskew_image = lambda img: (img, 0.0)
        poa.collapse_ratio = lambda raw: 0.0
        poa.run_inference = lambda img: (_TWO_VOICE_KERN, 1.0)  # same 2-voice content, used as both pages

        result = poa.score_pages_with_page_omr(
            [(b"p1", "image/png"), (b"p2", "image/png")], start_measure=1)
    finally:
        (poa._ensure_model_loaded, poa._bytes_to_image, poa.deskew_image,
         poa.run_inference, poa.collapse_ratio) = (
            orig_ensure, orig_decode, orig_deskew, orig_infer, orig_ratio)

    check("no top-level error", "error" not in result, str(result))
    measures = result.get("measures") or []
    check("2 measures total (1 per page), continuously numbered 1,2",
          [m["number"] for m in measures] == [1, 2], str(measures))
    check("page tags match source page (1, 2)",
          [m["page"] for m in measures] == [1, 2], str(measures))
    for m in measures:
        voice_counts = {n.get("voice") for n in m["notes"]}
        check(f"measure {m['number']}: both voices (0 and 1) present, 6 notes total, none dropped",
              voice_counts == {0, 1} and len(m["notes"]) == 6, str(m))


def test_case_f_tied_note_across_measure_boundary_tagged_not_merged_or_dropped():
    print("\n[14] Case F -- a note tied across a measure boundary: both "
          "halves survive as separate per-measure onset events (the only "
          "representation the per-measure canonical schema can hold), each "
          "tagged with the correct tie type, so a consumer can recognize "
          "they are one sustained pitch rather than two independent onsets.")
    measures, err = poa.kern_to_measures(_TIED_NOTE_KERN)
    check("no parse error", err is None, str(err))
    check("exactly 2 measures", len(measures) == 2, str(measures))
    m1_notes = measures[0]["notes"] if measures else []
    m2_notes = measures[1]["notes"] if len(measures) > 1 else []
    check("measure 1 has 4 notes (C4 D4 E4 F4), last one tied 'start'",
          len(m1_notes) == 4 and m1_notes[-1]["pitch"] == "F4" and m1_notes[-1]["tied"] == "start",
          str(m1_notes))
    check("measure 2 has 4 notes (F4 G4 A4 B4), first one tied 'stop'",
          len(m2_notes) == 4 and m2_notes[0]["pitch"] == "F4" and m2_notes[0]["tied"] == "stop",
          str(m2_notes))
    check("no other note in either measure is marked tied",
          all(n["tied"] is None for n in (m1_notes[:-1] + m2_notes[1:])),
          str(m1_notes + m2_notes))


def main():
    print("=" * 70)
    print("page_omr_adapter — ground truth tests")
    print("=" * 70)
    for t in (
        test_kern_to_measures_fixes_the_zero_numbering_bug,
        test_kern_to_measures_reports_unparseable_output_as_an_error_not_a_crash,
        test_collapse_ratio_empty_string_is_zero,
        test_score_pages_with_page_omr_concatenates_and_renumbers_across_pages,
        test_score_pages_with_page_omr_all_pages_fail_returns_structured_error,
        test_score_pages_with_page_omr_partial_failure_keeps_good_pages_and_flags_bad_ones,
        test_score_pages_with_page_omr_exposes_page_kern_and_failed_pages,
        test_score_pages_with_page_omr_detects_duplicate_page_upload,
        test_case_a_single_melody_unchanged_part_and_voice_default_to_backward_compatible_values,
        test_case_b_two_simultaneous_independent_voices_both_fully_preserved,
        test_case_c_chord_pitches_preserved_as_separate_events_not_merged_or_dropped,
        test_case_d_two_independent_parts_both_fully_preserved,
        test_case_e_two_page_continuation_preserves_voices_and_continuous_numbering,
        test_case_f_tied_note_across_measure_boundary_tagged_not_merged_or_dropped,
    ):
        try:
            t()
        except Exception as e:  # noqa: BLE001
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
