"""
Mentor-recommended (round 3, point 2) smallest controlled experiment on
dense-passage pitch misreads -- revised after checking the real interface
contract first (mentor's own step 1, "verify the interface contract
before spending credits").

ORIGINAL premise (rejected after checking the code): that production
sends Claude whole PAGES, so a tighter crop had never been tried. FALSE
-- _read_score_notes_claude_once already splits every page into per-row
crops before the initial 3-way read (_prepare_score_rows /
split_page_into_rows), and resolve_measure_disagreement already resolves
disagreements against a tight single-MEASURE crop when segmentation
confidence allows it (worker.py ~6065-6082). Both tiers already run in
production and piece 2243 still scored 0/20 exact-measure, 30.7% pitch
accuracy (see score_detailed_metrics.py's rerun of probe_result_2243.json).

REAL open question found while checking that contract: crop tightness
during resolution is CONDITIONAL -- worker.py:6080 falls back to the
WHOLE ROW crop (not a tight measure crop) whenever segmentation
confidence < 0.6 or Claude's measure count for that row didn't match the
crop count (align_claude_to_measure_crops). Whether piece 2243's worst
measures actually got the tight crop or the whole-row fallback in the
real run is NOT observable from the existing probe log -- this script
answers that empirically by forcing BOTH conditions for the same target
measures and comparing, isolating crop tightness as the one variable.

Does NOT call resolve_measure_disagreement or any other production
function that makes a real API call -- builds its own minimal,
equivalent single-call prompts (open transcription, not the multiple-
-choice framing resolve_measure_disagreement uses, specifically to avoid
that confound) so this experiment measures the image-crop variable
alone.
"""
import base64
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
from score_detailed_metrics import align_measure, _normalize_notes  # noqa: E402

import anthropic

SONNET5_INPUT_PER_TOKEN = 2.00 / 1_000_000
SONNET5_OUTPUT_PER_TOKEN = 10.00 / 1_000_000

DURATION_UNITS_TEXT = (
    "DURATION UNITS FOR COMPOUND TIME (6/8, 9/8, 12/8, and similar): one beat is a "
    "DOTTED QUARTER NOTE, not a plain quarter note. A 12/8 measure has 4 beats (not "
    "6), a 9/8 measure has 3 beats (not 4.5), a 6/8 measure has 2 beats (not 3). For "
    "simple time signatures (4/4, 3/4, 2/4, etc.) one beat is a plain quarter note "
    "as usual -- this only changes for compound meters."
)


def _call_claude(image_bytes: bytes, prompt: str) -> tuple[dict, float]:
    client = anthropic.Anthropic()
    b64 = base64.b64encode(image_bytes).decode()
    with client.messages.stream(
        model="claude-sonnet-5",
        max_tokens=2000,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            {"type": "text", "text": prompt},
        ]}],
    ) as stream:
        msg = stream.get_final_message()
    usage = getattr(msg, "usage", None)
    cost = 0.0
    if usage is not None:
        cost = (usage.input_tokens * SONNET5_INPUT_PER_TOKEN
                + usage.output_tokens * SONNET5_OUTPUT_PER_TOKEN)
        print(f"  [cost] input_tokens={usage.input_tokens} output_tokens={usage.output_tokens} (${cost:.4f})")
    raw = "".join(block.text for block in msg.content if block.type == "text")
    parsed = w.extract_json_object(raw) or {}
    return parsed, cost


def naive_equal_width_crop(row_bytes: bytes, position: int, n_measures: int,
                            upscale: float = 2.0) -> bytes:
    """
    Fallback tight crop when split_row_into_measures' real segmentation
    isn't trustworthy for this row (confidence < 0.6, or crop count
    doesn't match Claude's own measure count for the row -- both true
    for every target measure in this experiment, confirmed by direct
    inspection before spending anything: this specific piece's dense/fast
    passages are exactly where the deterministic barline detector itself
    struggles, a separate, previously undiagnosed problem from the vision
    pitch-reading question this experiment is about).

    NOT a substitute for real segmentation -- just slices the row image
    into N equal-width horizontal strips (N = Claude's own measure count
    for this row) and takes the one at `position`. Crude, but isolates
    the two variables this experiment cares about: less visual clutter
    per image, and more pixels-per-note once upscaled -- without
    depending on the same segmentation step that's already failing here.
    """
    from PIL import Image
    import io

    img = Image.open(io.BytesIO(row_bytes))
    w_px, h_px = img.size
    strip_w = w_px // n_measures
    left = (position - 1) * strip_w
    right = w_px if position == n_measures else left + strip_w
    crop = img.crop((left, 0, right, h_px))
    if upscale != 1.0:
        new_size = (int(crop.width * upscale), int(crop.height * upscale))
        crop = crop.resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    crop.save(buf, format="PNG")
    return buf.getvalue()


def transcribe_tight_crop(crop_bytes: bytes, instrument: str, time_sig: str) -> tuple[list, float]:
    prompt = f"""You are an expert music engraver reading sheet music for a {instrument} student.

Here is ONE measure, cropped tightly from a printed score. Time signature: {time_sig}.

{DURATION_UNITS_TEXT}

Transcribe every note in this measure. For each sounded note:
- "p": pitch in scientific notation ("D3", "F#4") -- null only if notehead present but pitch unreadable
- "b": beat position in measure (1.0 = downbeat)
- "d": duration in beats
Also return written rests of a beat or longer: "r": true, "b": beat position, "d": duration, no "p".

Return JSON only (no markdown): {{"notes": [{{"p": "D3", "b": 1.0, "d": 1.5}}, ...]}}"""
    parsed, cost = _call_claude(crop_bytes, prompt)
    return (parsed.get("notes") or []), cost


def transcribe_row_pick_measure(row_bytes: bytes, instrument: str, time_sig: str,
                                 measure_position: int, n_measures_in_row: int) -> tuple[list, float]:
    prompt = f"""You are an expert music engraver reading sheet music for a {instrument} student.

Here is one horizontal row (system) of a printed score, containing {n_measures_in_row} measure(s) left to right. Time signature: {time_sig}.

{DURATION_UNITS_TEXT}

Transcribe every measure in this row, left to right, numbering them 1 to {n_measures_in_row} by position in the row (position 1 = leftmost). For each sounded note in each measure:
- "p": pitch in scientific notation ("D3", "F#4") -- null only if notehead present but pitch unreadable
- "b": beat position in measure (1.0 = downbeat)
- "d": duration in beats
Also return written rests of a beat or longer: "r": true, "b": beat position, "d": duration, no "p".

Return JSON only (no markdown): {{"measures": [{{"position": 1, "notes": [...]}}, ...]}}"""
    parsed, cost = _call_claude(row_bytes, prompt)
    for m in parsed.get("measures") or []:
        if m.get("position") == measure_position:
            return (m.get("notes") or []), cost
    return [], cost


def main():
    corpus_dir = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    ground_truth = json.loads((corpus_dir / "ground_truth.json").read_text())
    probe = json.loads(Path(__file__).with_name("probe_result_2243.json").read_text())

    piece_id = "2243"
    gt_entry = ground_truth[piece_id]
    time_sig = gt_entry["time_signature"]
    instrument = gt_entry.get("instrument", "Violin")
    gt_by_number = {m["number"]: m for m in gt_entry["measures"]}
    qlpb = w.quarter_lengths_per_beat(time_sig) or 1.0

    page_path = sorted((corpus_dir / "clean").glob(f"{piece_id}_page*.png"))[0]
    page_bytes = page_path.read_bytes()
    prepared = w._prepare_score_rows([(page_bytes, "image/png")])
    rows = prepared[0]["rows"]

    # Worst measures by note-error-rate from the already-collected probe
    # (score_detailed_metrics.py output): m.16 (del=10/11, worst),
    # m.6 (del=13/25), m.1 (sub=7/9, the one manually diagnosed earlier).
    target_numbers = [16, 6, 1]

    predicted_by_number = {m["number"]: m for m in probe["predicted_measures"]}
    # Group this page's predicted measures by row, ascending by number --
    # same left-to-right order align_claude_to_measure_crops assumes.
    by_row: dict[int, list[int]] = {}
    for m in probe["predicted_measures"]:
        by_row.setdefault(m["row"], []).append(m["number"])
    for row_idx in by_row:
        by_row[row_idx].sort()

    total_cost = 0.0
    results = []
    for number in target_numbers:
        pred_measure = predicted_by_number.get(number)
        if pred_measure is None:
            print(f"m.{number}: not in predicted_measures, skipping")
            continue
        row_idx = pred_measure["row"]
        if not (1 <= row_idx <= len(rows)):
            print(f"m.{number}: row {row_idx} out of range, skipping")
            continue
        row = rows[row_idx - 1]
        row_numbers = by_row.get(row_idx, [])
        position = row_numbers.index(number) + 1 if number in row_numbers else None
        segmentation = row["segmentation"]
        crops = segmentation.get("measures") or []
        tight_crop = None
        tight_crop_source = None
        if (segmentation.get("confidence", 0.0) >= 0.6
                and position is not None and len(crops) == len(row_numbers)
                and 1 <= position <= len(crops)):
            tight_crop = crops[position - 1]
            tight_crop_source = "real_segmentation"
        elif position is not None and row_numbers:
            # Real segmentation isn't trustworthy for this row (see
            # naive_equal_width_crop's docstring) -- fall back to a
            # naive equal-width slice so the experiment still runs
            # instead of silently skipping every target measure.
            tight_crop = naive_equal_width_crop(row["row_bytes"], position, len(row_numbers))
            tight_crop_source = "naive_equal_width"

        gt_measure = gt_by_number[number]
        gt_notes_norm = _normalize_notes(gt_measure["notes"], qlpb, from_quarter_lengths=True)

        print(f"\n=== m.{number} (row {row_idx}, position {position}, "
              f"tight_crop_source={tight_crop_source}) ===")

        row_notes, cost_a = transcribe_row_pick_measure(
            row["row_bytes"], instrument, time_sig, position or 1, len(row_numbers) or 1)
        total_cost += cost_a
        row_notes_norm = _normalize_notes(row_notes, qlpb, from_quarter_lengths=False)
        row_align = align_measure(row_notes_norm, gt_notes_norm)
        print(f"  whole-row read:  pred={row_align['n_pred']} gt={row_align['n_gt']} "
              f"matches={row_align['matches']} sub={row_align['substitutions']} "
              f"ins={row_align['insertions']} del={row_align['deletions']}")

        tight_align = None
        if tight_crop is not None:
            tight_notes, cost_b = transcribe_tight_crop(tight_crop, instrument, time_sig)
            total_cost += cost_b
            tight_notes_norm = _normalize_notes(tight_notes, qlpb, from_quarter_lengths=False)
            tight_align = align_measure(tight_notes_norm, gt_notes_norm)
            print(f"  tight-crop read: pred={tight_align['n_pred']} gt={tight_align['n_gt']} "
                  f"matches={tight_align['matches']} sub={tight_align['substitutions']} "
                  f"ins={tight_align['insertions']} del={tight_align['deletions']}")
        else:
            print("  tight-crop read: SKIPPED (segmentation not confident enough for this measure)")

        original_pred = pred_measure.get("notes") or []
        original_norm = _normalize_notes(original_pred, qlpb, from_quarter_lengths=False)
        original_align = align_measure(original_norm, gt_notes_norm)
        print(f"  original probe (production, 3-way+resolution): pred={original_align['n_pred']} "
              f"gt={original_align['n_gt']} matches={original_align['matches']} "
              f"sub={original_align['substitutions']} ins={original_align['insertions']} "
              f"del={original_align['deletions']}")

        results.append({
            "number": number, "row": row_idx, "position": position,
            "original": original_align, "whole_row_fresh": row_align,
            "tight_crop": tight_align,
        })

    print(f"\n{'=' * 70}")
    print(f"Total real cost this run: ${total_cost:.4f}")
    print(f"{'=' * 70}")

    out_path = Path(__file__).with_name("crop_tightness_experiment_results.json")
    out_path.write_text(json.dumps({"total_cost": round(total_cost, 4), "results": results}, indent=2))
    print(f"Full results written to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
