import sys, os
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate_smt_cropped_input as esc  # noqa: E402

RESULTS = []


def check(desc, passed, detail=""):
    RESULTS.append(passed)
    print(f"  {'PASS' if passed else 'FAIL'}  {desc}" + (f"   {detail}" if detail else ""))


def _fake_prepare_score_rows(pages):
    """Two rows, both with real-looking readability/segmentation metadata,
    standing in for worker._prepare_score_rows without needing a real
    image or PIL/numpy at all."""
    return [{
        "page_mime": pages[0][1], "page_bytes": pages[0][0],
        "rows": [
            {"row_bytes": b"fake-row-0-bytes",
             "readability": {"quality": "good", "interline_px": 8, "reasons": []},
             "segmentation": {"measures": [b"m1", b"m2"], "boundaries": [10, 20], "confidence": 0.9}},
            {"row_bytes": b"fake-row-1-bytes",
             "readability": {"quality": "marginal", "interline_px": 6, "reasons": ["low contrast"]},
             "segmentation": {"measures": [b"m1"], "boundaries": [], "confidence": 0.0}},
        ],
    }]


def test_counts_a_row_that_decoded_a_real_note_as_having_a_real_note():
    print("\n[1] a row whose SMT result has at least one note in any measure "
          "is counted as has_real_note=True, with the real note_count/measure_count")
    with patch.object(esc.w, "_prepare_score_rows", side_effect=_fake_prepare_score_rows), \
         patch.object(esc.si, "transcribe_row_with_smt",
                      return_value={"measures": [{"number": 1, "notes": [
                          {"pitch": "C4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]}],
                                    "source": "smt"}):
        page_path = Path("/tmp/fake_page1.png")
        with patch.object(Path, "glob", return_value=[page_path]), \
             patch.object(Path, "read_bytes", return_value=b"fake-page-bytes"):
            report = esc.transcribe_rows_and_check_for_notes(
                "fake_piece", "Piano", Path("/tmp"), "fake/checkpoint")

    check("found 2 rows (both fake rows from the one fake page)",
          len(report["rows"]) == 2, str(len(report["rows"])))
    check("both rows report has_real_note=True (mock returns the same result for each call)",
          all(r["has_real_note"] for r in report["rows"]), str(report["rows"]))
    check("note_count is 1 (one real note in the mocked measures)",
          report["rows"][0]["note_count"] == 1, str(report["rows"][0]["note_count"]))
    check("crop_quality/segmentation_confidence are threaded through from the row metadata",
          report["rows"][0]["crop_quality"] == "good"
          and report["rows"][1]["crop_quality"] == "marginal",
          str([r["crop_quality"] for r in report["rows"]]))


def test_counts_a_header_only_row_as_not_having_a_real_note():
    print("\n[2] a row whose SMT result decodes a header but zero notes "
          "(the real whole-page failure mode from Task 3) is counted as "
          "has_real_note=False, not crashed or miscounted")
    with patch.object(esc.w, "_prepare_score_rows", side_effect=_fake_prepare_score_rows), \
         patch.object(esc.si, "transcribe_row_with_smt",
                      return_value={"measures": [], "source": "smt"}):
        page_path = Path("/tmp/fake_page1.png")
        with patch.object(Path, "glob", return_value=[page_path]), \
             patch.object(Path, "read_bytes", return_value=b"fake-page-bytes"):
            report = esc.transcribe_rows_and_check_for_notes(
                "fake_piece", "Violin", Path("/tmp"), "fake/checkpoint")

    check("no row reports has_real_note=True",
          not any(r["has_real_note"] for r in report["rows"]), str(report["rows"]))
    check("note_count is 0 for every row", all(r["note_count"] == 0 for r in report["rows"]))


def test_a_row_level_error_is_recorded_without_crashing_the_whole_piece():
    print("\n[3] one row's SMT error (e.g. a timeout) is recorded on that row "
          "and does not stop the other rows of the same piece from running")
    results = iter([
        {"error": "SMT inference exceeded 45s for this page", "measures": [], "source": "smt"},
        {"measures": [{"number": 1, "notes": [
            {"pitch": "D4", "is_rest": False, "beat": 1.0, "duration_beats": 1.0}]}],
         "source": "smt"},
    ])
    with patch.object(esc.w, "_prepare_score_rows", side_effect=_fake_prepare_score_rows), \
         patch.object(esc.si, "transcribe_row_with_smt", side_effect=lambda *a, **kw: next(results)):
        page_path = Path("/tmp/fake_page1.png")
        with patch.object(Path, "glob", return_value=[page_path]), \
             patch.object(Path, "read_bytes", return_value=b"fake-page-bytes"):
            report = esc.transcribe_rows_and_check_for_notes(
                "fake_piece", "Cello", Path("/tmp"), "fake/checkpoint")

    check("first row's error is recorded",
          report["rows"][0]["error"] == "SMT inference exceeded 45s for this page",
          str(report["rows"][0]["error"]))
    check("first row still correctly reports has_real_note=False on an error",
          report["rows"][0]["has_real_note"] is False)
    check("second row ran anyway and correctly reports has_real_note=True",
          report["rows"][1]["has_real_note"] is True, str(report["rows"][1]))
    check("second row has no error",
          report["rows"][1]["error"] is None, str(report["rows"][1]["error"]))


def test_a_page_with_no_detected_rows_is_skipped_without_crashing():
    print("\n[4] a page where _prepare_score_rows found zero rows (single-"
          "system page, or row detection declining to split it) is skipped "
          "cleanly -- no crash, no fabricated row entries")
    with patch.object(esc.w, "_prepare_score_rows",
                       return_value=[{"page_mime": "image/png", "page_bytes": b"x", "rows": []}]), \
         patch.object(esc.si, "transcribe_row_with_smt") as mock_transcribe:
        page_path = Path("/tmp/fake_page1.png")
        with patch.object(Path, "glob", return_value=[page_path]), \
             patch.object(Path, "read_bytes", return_value=b"fake-page-bytes"):
            report = esc.transcribe_rows_and_check_for_notes(
                "fake_piece", "Flute", Path("/tmp"), "fake/checkpoint")

    check("zero rows reported", report["rows"] == [], str(report["rows"]))
    check("transcribe_row_with_smt was never called (nothing to transcribe)",
          mock_transcribe.call_count == 0, str(mock_transcribe.call_count))


def main():
    test_counts_a_row_that_decoded_a_real_note_as_having_a_real_note()
    test_counts_a_header_only_row_as_not_having_a_real_note()
    test_a_row_level_error_is_recorded_without_crashing_the_whole_piece()
    test_a_page_with_no_detected_rows_is_skipped_without_crashing()
    passed = sum(1 for r in RESULTS if r)
    total = len(RESULTS)
    print(f"\n{'='*70}\n{passed}/{total} checks passed\n{'='*70}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
