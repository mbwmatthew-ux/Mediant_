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
