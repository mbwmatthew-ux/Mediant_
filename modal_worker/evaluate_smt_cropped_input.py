"""
Phase 3 follow-up experiment (mentor-recommended priority #1): tests
whether SMT's 0% zero-shot result (evaluate_smt_zero_shot.py, whole-page
input) was an input-format mismatch rather than a deeper model limitation,
by feeding the model CORRECTLY-SHAPED input instead -- the same per-system
row crops worker._prepare_score_rows already produces for Claude's own
reading path (split_page_into_rows -> dewarp_row -> split_row_into_measures).

Zero Anthropic/Google API cost: SMT runs entirely as self-hosted inference,
and worker._prepare_score_rows is pure local image processing (no API call).

IMPORTANT SCOPE NOTE, carried from the final whole-branch review of the
Phase 1-2 plan: a "row" crop from split_page_into_rows is one detected
ink-density system, instrument-agnostic. For the corpus's one piano entry
that IS a real grand-staff (two-stave) crop -- exactly the shape
antoniorv6/smt-grandstaff was trained on. For the other 24 corpus pieces
(solo violin/cello/flute, single-staff notation), a "row" crop is ONE
staff, not a grand staff -- still not a full training-distribution match
even though the whole-page/multi-system confound is removed. This script
reports piano and non-piano results SEPARATELY, never blended into one
number, so a positive (or negative) piano result is never misread as
evidence about the other 24 pieces, and vice versa.

PRIMARY METRIC is deliberately binary, not a measure-accuracy percentage:
did this row crop make the model decode ANY real note/rest token at all
(as opposed to a header followed immediately by <eos>, which is what
EVERY whole-page run in evaluate_smt_zero_shot.py produced)? Task 3's own
real whole-page run never exercised the note-decoding branch even once
(see smt_inference.py's module docstring, point 9). Answering that binary
question first is the direct, low-risk way to find out whether correctly-
shaped input unlocks real output at all, without first having to build and
independently verify a row-to-ground-truth-measure-number alignment
pipeline (nontrivial: split_row_into_measures' per-row measure COUNT is
itself a visual estimate, not ground truth, so trusting it to assign
absolute measure numbers would risk silently mis-scoring real vs. crop-
segmentation error as if they were the same thing). If this binary signal
comes back positive on a meaningful fraction of rows, that result justifies
building the harder alignment-based accuracy measurement as a follow-up;
if it does not, that larger investment would have been wasted motion.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import smt_inference as si  # noqa: E402
import worker as w  # noqa: E402 -- needs the real modal/PIL/numpy stack; run in the validation venv.

# Small, deliberate subset, not the full 25-piece corpus: every piece here
# is single-page, bounding worst-case wall-clock (CPU inference has no KV
# cache -- see smt_inference.py point 8 -- so cost scales with how many
# rows get fed in, and this is a fast first look, not the full corpus
# sweep). piano_synthetic is the one true grand-staff case; the other
# three are the smallest single-page pieces across the three non-piano
# instruments in the corpus, for a same-cost comparison across instruments.
CROPPED_INPUT_SUBSET = {
    "piano_synthetic": "Piano",
    "2243": "Violin",
    "2296": "Cello",
    "2204": "Flute",
}


def transcribe_rows_and_check_for_notes(piece_id: str, instrument: str,
                                          corpus_dir: Path, checkpoint: str) -> dict:
    """
    Runs every row of every page of one piece through transcribe_row_with_smt
    and reports, per row: whether it produced >=1 real note/rest token, how
    many measures/notes it decoded, the row's own crop-quality signals from
    _prepare_score_rows (readability, segmentation confidence -- context for
    interpreting a negative result, not used to score it), and how long
    inference took. Returns {"piece_id", "instrument", "rows": [...]}.
    """
    page_paths = sorted(corpus_dir.glob(f"{piece_id}_page*.png"))
    row_reports = []
    for page_path in page_paths:
        page_bytes = page_path.read_bytes()
        prepared = w._prepare_score_rows([(page_bytes, "image/png")])
        rows = prepared[0]["rows"] if prepared else []
        if not rows:
            print(f"    {page_path.name}: _prepare_score_rows found no rows "
                  f"(single-system page, or row detection declined to split it)",
                  flush=True)
            continue
        for row_idx, row in enumerate(rows):
            start = time.monotonic()
            result = si.transcribe_row_with_smt(row["row_bytes"], checkpoint)
            elapsed = round(time.monotonic() - start, 1)
            measures = result.get("measures") or []
            note_count = sum(1 for m in measures for n in m["notes"])
            has_real_note = note_count > 0
            print(f"    {page_path.name} row {row_idx}: "
                  f"{'NOTE DECODED' if has_real_note else 'header/empty only'} "
                  f"({note_count} notes across {len(measures)} measures, "
                  f"{elapsed}s, crop_quality={row['readability']['quality']}, "
                  f"segmentation_confidence={round(row['segmentation']['confidence'], 2)})"
                  + (f" | error: {result['error']}" if result.get("error") else ""),
                  flush=True)
            row_reports.append({
                "page": page_path.name, "row_idx": row_idx,
                "has_real_note": has_real_note, "note_count": note_count,
                "measure_count": len(measures), "elapsed_seconds": elapsed,
                "crop_quality": row["readability"]["quality"],
                "segmentation_confidence": round(row["segmentation"]["confidence"], 2),
                "error": result.get("error"),
            })
    return {"piece_id": piece_id, "instrument": instrument, "rows": row_reports}


def main():
    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus") / "clean"
    checkpoint = "antoniorv6/smt-grandstaff"

    all_reports = []
    for piece_id, instrument in CROPPED_INPUT_SUBSET.items():
        print(f"\n--- {piece_id} ({instrument}) ---", flush=True)
        all_reports.append(
            transcribe_rows_and_check_for_notes(piece_id, instrument, corpus_dir, checkpoint))

    print("\n" + "=" * 70)
    print("SUMMARY -- rows that decoded >=1 real note, by instrument")
    print("=" * 70)
    for report in all_reports:
        rows = report["rows"]
        n_rows = len(rows)
        n_with_notes = sum(1 for r in rows if r["has_real_note"])
        pct = round(100 * n_with_notes / n_rows, 1) if n_rows else 0.0
        print(f"  {report['piece_id']} ({report['instrument']}): "
              f"{n_with_notes}/{n_rows} rows decoded a real note ({pct}%)")

    piano_rows = [r for rep in all_reports if rep["instrument"] == "Piano" for r in rep["rows"]]
    non_piano_rows = [r for rep in all_reports if rep["instrument"] != "Piano" for r in rep["rows"]]
    for label, rows in (("PIANO (true grand-staff training shape)", piano_rows),
                         ("NON-PIANO (single-staff, still a partial shape mismatch)", non_piano_rows)):
        n_rows = len(rows)
        n_with_notes = sum(1 for r in rows if r["has_real_note"])
        pct = round(100 * n_with_notes / n_rows, 1) if n_rows else 0.0
        print(f"\n  {label}: {n_with_notes}/{n_rows} rows decoded a real note ({pct}%)")

    out_path = Path(__file__).parent / "smt_cropped_input_results.json"
    out_path.write_text(json.dumps(all_reports, indent=2))
    print(f"\nFull per-row results written to {out_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
