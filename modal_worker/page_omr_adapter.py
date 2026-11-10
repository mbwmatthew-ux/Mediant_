"""
page-omr + deskew adapter — a STAGING-ONLY alternate score-reading engine.

Not used by default. Selected only when MEDIANT_SCORE_ENGINE=page_omr is set
on the Modal deployment (see _score_pipeline in worker.py) — unset or any
other value keeps the existing Claude+Audiveris path unchanged. See the
owner's "MEDIANT — Integrate page-omr + Deskew Into Staging" directive
(2026-10-31) for the authorization and scope this module implements.

Every number and design decision referenced in this file's comments was
measured, not assumed — see:
  agent_workspace/PAGE_OMR_BENCHMARK_FINDINGS.md        (5-piece pilot)
  agent_workspace/PAGE_OMR_EXPANDED_FINDINGS.md         (20-piece expansion,
                                                          failure-detector limits)
  agent_workspace/PAGE_OMR_ROOT_CAUSE_FINDINGS.md       (structural-error
                                                          root cause, deskew pilot)
  agent_workspace/PAGE_OMR_DESKEW_FULL_VALIDATION.md    (full 109-page deskew
                                                          validation, INTEGRATE)

Checkpoint: tobiashornbogen/page-omr-a1-kern (the README's documented
default, MIT-licensed weights + code). Model/repo pinned to commit
e369a44a8232ddcf0ddd915f7e07b19cdcb91b61 in the Modal image (see worker.py's
image definition) — the exact commit every validation number above was
produced against.

Does NOT implement the length-based "likely unreliable" character-count
threshold built during the expanded-validation round — that signal was
explicitly found NOT to generalize (21 false positives across a 40-case
expansion; see PAGE_OMR_EXPANDED_FINDINGS.md) and the owner's root-cause
directive explicitly rejected using it ("A length-based metric does not
reliably detect wrong notes in otherwise normal-looking transcription
output"). The repetition-collapse signal below is kept because it measured
zero false positives across every case tested (53 cases, two full
validation rounds) — it is a narrow, low-recall "this output is literally
degenerate" check, not a general accuracy or confidence estimate, and this
module makes no stronger claim than that about any output it returns.
"""
from __future__ import annotations

import re
import time

_CHECKPOINT_REPO = "tobiashornbogen/page-omr-a1-kern"
_MAX_LENGTH = 3072
_COLLAPSE_RATIO_THRESHOLD = 0.3  # validated: zero false positives across 53 cases

_model = None
_tokenizer = None
_image_processor = None


# ---------------------------------------------------------------------------
# Copied verbatim from modal_worker/worker.py's _otsu_threshold/_binarize_ink
# (worker.py lines ~3924-3990). Duplicated rather than imported: worker.py
# imports THIS module (to call score_pages_with_page_omr), so an import the
# other way would be circular. Keep this in sync by inspection if worker.py's
# originals ever change — they are small, pure, and have no reason to.
# ---------------------------------------------------------------------------
def _otsu_threshold(values) -> float:
    import numpy as np
    vmax = float(values.max())
    if vmax <= 0:
        return 0.0
    hist, bin_edges = np.histogram(values, bins=256, range=(0, vmax))
    hist = hist.astype(np.float64)
    total = hist.sum()
    sum_all = float(np.sum(hist * np.arange(256)))
    sum_bg = 0.0
    weight_bg = 0.0
    best_var = 0.0
    best_bin = 0
    for i in range(256):
        weight_bg += hist[i]
        if weight_bg == 0:
            continue
        weight_fg = total - weight_bg
        if weight_fg == 0:
            break
        sum_bg += i * hist[i]
        mean_bg = sum_bg / weight_bg
        mean_fg = (sum_all - sum_bg) / weight_fg
        between_var = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
        if between_var > best_var:
            best_var = between_var
            best_bin = i
    return float(bin_edges[best_bin])


def _binarize_ink(arr):
    threshold = _otsu_threshold(arr.flatten())
    if threshold <= arr.min():
        threshold = (float(arr.min()) + float(arr.max())) / 2.0
    return arr < threshold, threshold


# ---------------------------------------------------------------------------
# FROZEN — ported unchanged from the validated scratchpad deskew.py (see
# PAGE_OMR_DESKEW_FULL_VALIDATION.md: "use the current deskew implementation
# unchanged — no parameters touched after viewing any held-out result").
# Do not retune the search range/step or the scoring function independently
# of re-running the full validation — the +26.0pt mild-tier gain was
# measured against exactly this code.
# ---------------------------------------------------------------------------
def estimate_skew_angle(img, search_range: float = 10.0, step: float = 0.5) -> float:
    import numpy as np
    from PIL import Image

    gray = np.array(img.convert("L")).astype(np.float64)
    is_ink, _ = _binarize_ink(gray)
    ink = Image.fromarray((is_ink * 255).astype(np.uint8))

    best_angle, best_score = 0.0, -1.0
    angle = -search_range
    while angle <= search_range:
        rotated = ink.rotate(angle, expand=False, fillcolor=0)
        arr = np.array(rotated).astype(np.float64)
        row_sums = arr.sum(axis=1)
        score = row_sums.var()
        if score > best_score:
            best_score, best_angle = score, angle
        angle += step
    return best_angle


def deskew_image(img):
    """Returns (deskewed PIL.Image in RGB, angle_degrees)."""
    angle = estimate_skew_angle(img)
    corrected = img.convert("RGB").rotate(angle, expand=False, fillcolor=(255, 255, 255))
    return corrected, angle


# ---------------------------------------------------------------------------
# Model loading — lazy singleton, loaded once per Modal container (not once
# per request). device="cpu": no GPU authorization has been granted for this
# staging integration (see the directive's constraints); measured CPU
# latency is ~11.4s/page inference + ~0.65s/page deskew (PAGE_OMR_DESKEW_
# FULL_VALIDATION.md, 109-page measurement) and is treated as acceptable for
# staging testing, not as a production SLA commitment.
# ---------------------------------------------------------------------------
def _ensure_model_loaded():
    global _model, _tokenizer, _image_processor
    if _model is not None:
        return
    from omr.utils.hub import load_from_hub

    _model, _tokenizer, _image_processor, _config = load_from_hub(_CHECKPOINT_REPO, device="cpu")
    _model.eval()


def _bytes_to_image(page_bytes: bytes, mime: str):
    from PIL import Image
    import io

    if "pdf" in (mime or "").lower():
        import fitz  # pymupdf, already a worker.py dependency

        doc = fitz.open(stream=page_bytes, filetype="pdf")
        pix = doc[0].get_pixmap(dpi=300)
        return Image.open(io.BytesIO(pix.tobytes("png")))
    return Image.open(io.BytesIO(page_bytes))


def run_inference(image) -> tuple[str, float]:
    """Returns (raw_kern_text, elapsed_seconds). Greedy decoding (num_beams=1),
    matching the paper protocol and every number in the validation docs."""
    import torch
    from omr.inference.postprocess import postprocess_output
    from omr.inference.repair import repair_kern_prediction

    _ensure_model_loaded()
    if image.mode != "RGB":
        image = image.convert("RGB")
    pixel_values = _image_processor(image, return_tensors="pt")["pixel_values"]

    t0 = time.time()
    with torch.no_grad():
        ids = _model.generate(pixel_values, max_length=_MAX_LENGTH, num_beams=1, repetition_penalty=1.0)
    raw = _tokenizer.decode(ids[0].tolist(), skip_special_tokens=True)
    elapsed = time.time() - t0

    prediction = postprocess_output(raw)
    prediction = repair_kern_prediction(prediction)
    return prediction, elapsed


def collapse_ratio(raw_kern: str) -> float:
    """1 - (len after collapsing repeated lines/patterns) / (raw len). Reused
    verbatim from page-omr's own repo (src/omr/inference/postprocess.py);
    it exists there but isn't wired into the package's default inference
    path."""
    if not raw_kern:
        return 0.0
    from omr.inference.postprocess import detect_repetition_loops

    collapsed = detect_repetition_loops(raw_kern)
    return 1 - len(collapsed) / len(raw_kern)


# ---------------------------------------------------------------------------
# Canonicalization — ported verbatim from the validated scratchpad's
# page_omr_score.kern_to_measures (which itself ported extract_ground_truth_
# measures from modal_worker/build_visual_validation_corpus.py), including
# the measure-renumbering-by-position fix. The note shape this produces
# ({"pitch", "is_rest", "beat", "duration_beats"}) is already Mediant's
# canonical shape — the SAME fields parse_musicxml and read_score_notes_
# claude both emit (confirmed by direct comparison against worker.py
# lines ~1505-1552 and ~5180-5187). No translation layer is needed.
# ---------------------------------------------------------------------------
def _note_dict(el, pitch_name: str | None, is_rest: bool, part_idx: int, voice_id) -> dict:
    tie = getattr(el, "tie", None)
    return {
        "pitch": pitch_name, "is_rest": is_rest,
        "beat": float(el.beat), "duration_beats": float(el.duration.quarterLength),
        "part": part_idx, "voice": voice_id,
        "tied": tie.type if tie is not None else None,
    }


def _measure_note_dicts(measure, part_idx: int) -> list:
    """
    Every note/chord-pitch/rest in ONE measure of ONE part, tagged with
    part/voice identity and tie type. music21 represents simultaneous
    independent voices as Voice stream objects nested INSIDE the Measure
    (confirmed empirically, including on real page-omr output with
    Humdrum spine-split "*^"/"*v" tokens) — measure.notesAndRests (no
    recurse) returns [] whenever voices are present, so the two branches
    below are mutually exclusive and never double-count: a measure either
    has flat Note/Chord/Rest children (no voices) or Voice children (in
    which case the flat view is empty and everything comes from the
    voices).
    """
    import music21 as m21

    def _from_stream(stream_like, voice_id) -> list:
        out = []
        for el in stream_like.notesAndRests:
            if isinstance(el, m21.chord.Chord):
                for p in el.pitches:
                    out.append(_note_dict(el, p.nameWithOctave, False, part_idx, voice_id))
            elif isinstance(el, m21.note.Rest):
                out.append(_note_dict(el, None, True, part_idx, voice_id))
            elif isinstance(el, m21.note.Note):
                out.append(_note_dict(el, el.pitch.nameWithOctave, False, part_idx, voice_id))
        return out

    voices = list(measure.voices)
    if not voices:
        return _from_stream(measure, None)
    notes_out = []
    # Positional index, not v.id: music21's humdrum spine-split parsing
    # auto-assigns Voice.id from Python's own object id() (confirmed
    # directly on real page-omr spine-split output) -- a raw memory
    # address, not a stable or meaningful identity across parses of the
    # same text. Spine-split column order is stable within a piece, so
    # the voice's position within this measure (0 = leftmost sub-spine)
    # is both deterministic and the only ordering Humdrum itself gives.
    for voice_idx, v in enumerate(voices):
        notes_out.extend(_from_stream(v, voice_idx))
    return notes_out


def kern_to_measures(kern_text: str) -> tuple[list, str | None]:
    """
    Converts real page-omr kern output (which, measured directly, DOES
    correctly represent multiple staves as parallel **kern spines and
    simultaneous independent voices within one staff as Humdrum
    spine-split "*^"/"*v" sections -- see "MEDIANT -- Implement
    Multi-Voice Score Preservation", Task 1) into canonical measure
    dicts, preserving every part and voice rather than reading only
    parts[0] and only a measure's flat (non-Voice) children.

    Each returned measure dict is {"number": N, "notes": [...]}, with
    every note/chord-pitch/rest from EVERY part/voice at that measure
    position tagged "part" (0-based index) and "voice" (the Voice's id,
    or None when the measure has no Voice split) -- not one measure dict
    per part. Parts are stepped through in lockstep by POSITION (not by
    music21's own often-unreliable .number — see the renumbering note
    below); a part with fewer recognized measures than another
    contributes nothing for the missing position rather than crashing.
    """
    import music21 as m21
    from itertools import zip_longest

    try:
        score = m21.converter.parse(kern_text, format="humdrum")
    except Exception as e:  # noqa: BLE001 — a real transcription failure, not a bug to crash on
        return [], f"{type(e).__name__}: {e}"

    try:
        parts = list(score.parts) if len(score.parts) else [score]
        per_part_measures = []
        for part in parts:
            measures = list(part.getElementsByClass("Measure"))
            if not measures:
                part = part.makeMeasures()
                measures = list(part.getElementsByClass("Measure"))
            per_part_measures.append(measures)

        # music21's humdrum reader leaves measure.number == 0 on every measure
        # after the first for a bare "=" barline with no explicit number —
        # confirmed directly on real page-omr output (see PAGE_OMR_BENCHMARK_
        # FINDINGS.md: a musically-identical transcription scored ~12% before
        # this fix because 7 of 8 measures collapsed onto dict key 0). Reading
        # order from getElementsByClass is real left-to-right page order, so
        # numbering 1..N by position (not by measure.number) is safe, and
        # stepping every part in lockstep at the same position keeps a
        # measure's dict holding that same position's content from ALL parts.
        out = []
        for i, measures_at_position in enumerate(zip_longest(*per_part_measures), start=1):
            notes_out = []
            for part_idx, measure in enumerate(measures_at_position):
                if measure is None:
                    continue
                notes_out.extend(_measure_note_dicts(measure, part_idx))
            out.append({"number": i, "notes": notes_out})
        return out, None
    except Exception as e:  # noqa: BLE001
        return [], f"{type(e).__name__}: {e}"


# ---------------------------------------------------------------------------
# Production entry point.
# ---------------------------------------------------------------------------
def score_pages_with_page_omr(pages: list[tuple[bytes, str]], start_measure: int) -> dict:
    """
    Reads every page with page-omr (deskew -> inference -> kern parse),
    concatenating pages in upload order with measures renumbered
    sequentially from start_measure.

    Known limitation (disclosed, not silently assumed away): unlike the
    offline benchmark, which used the piece's own real MusicXML (via
    verovio) to know exactly which measures land on which page, production
    has no ground truth — multi-page continuity here is simple sequential
    concatenation, the same assumption the existing Claude path's own
    numbering-repair logic falls back on when printed numbers aren't
    legible. This has not been separately validated against the benchmark's
    privileged-mapping multi-page numbers; see this feature's staging
    validation report for what WAS tested.

    Returns the same shape read_score_notes_claude/parse_score_document
    return: measures/source/key_signature/time_signature/tempo_marking,
    plus "error" (no usable output at all) or "partial_error" (some but
    not all pages read) when applicable. Never raises.

    Also returns two fields the single-page callers can ignore and the
    multi-page V2 caller (worker.py's _run_analysis_v2) needs to build one
    combined note_array across every successfully-read page WITHOUT
    re-running inference a second time:
      - "page_kern": {page_idx: raw_kern} for every page that contributed
        measures, in upload order (1-based page_idx, same numbering as
        each measure's "page" tag).
      - "failed_pages": [page_idx, ...] for every page that did NOT
        contribute measures (decode/inference/degenerate/unparseable),
        structured rather than only embedded in the "partial_error" string,
        so a caller can report exactly which page(s) to re-upload.
      - "duplicate_page_warning": set when two different pages produced
        byte-identical recognition output (e.g. the same photo uploaded
        twice) -- a diagnostic, not a failure; the duplicate's measures
        are still included in "measures".
    """
    try:
        _ensure_model_loaded()
    except Exception as e:
        return {
            "measures": [], "source": "page_omr", "key_signature": None,
            "time_signature": None, "tempo_marking": None,
            "error": f"page-omr model failed to load: {type(e).__name__}: {e}",
        }

    all_measures: list[dict] = []
    next_number = start_measure
    page_errors: list[str] = []
    failed_pages: list[int] = []
    page_kern: dict[int, str] = {}

    for page_idx, (page_bytes, mime) in enumerate(pages, start=1):
        try:
            image = _bytes_to_image(page_bytes, mime)
        except Exception as e:
            page_errors.append(f"page {page_idx}: could not decode image ({type(e).__name__}: {e})")
            failed_pages.append(page_idx)
            continue

        try:
            deskewed, _angle = deskew_image(image)
            raw_kern, _elapsed = run_inference(deskewed)
        except Exception as e:
            page_errors.append(f"page {page_idx}: inference failed ({type(e).__name__}: {e})")
            failed_pages.append(page_idx)
            continue

        ratio = collapse_ratio(raw_kern)
        if ratio > _COLLAPSE_RATIO_THRESHOLD:
            page_errors.append(
                f"page {page_idx}: output looks degenerate "
                f"(repetition-collapse ratio {ratio:.3f} > {_COLLAPSE_RATIO_THRESHOLD})")
            failed_pages.append(page_idx)
            continue

        page_measures, parse_err = kern_to_measures(raw_kern)
        if parse_err:
            page_errors.append(f"page {page_idx}: unparseable output ({parse_err})")
            failed_pages.append(page_idx)
            continue
        if not page_measures:
            page_errors.append(f"page {page_idx}: parsed to zero measures")
            failed_pages.append(page_idx)
            continue

        for m in page_measures:
            m["number"] = next_number
            m["page"] = page_idx
            next_number += 1
        all_measures.extend(page_measures)
        page_kern[page_idx] = raw_kern

    duplicate_page_warning = None
    seen_kern: dict[str, int] = {}
    for idx, kern_text in page_kern.items():
        if kern_text in seen_kern:
            duplicate_page_warning = (
                f"page {seen_kern[kern_text]} and page {idx} produced identical "
                f"recognition output (possible duplicate upload)")
            break
        seen_kern[kern_text] = idx

    if not all_measures:
        return {
            "measures": [], "source": "page_omr", "key_signature": None,
            "time_signature": None, "tempo_marking": None,
            "error": ("page-omr could not read any page: " + "; ".join(page_errors))
                     if page_errors else "page-omr returned no measures",
            "failed_pages": failed_pages,
        }

    result = {
        "measures": all_measures, "source": "page_omr",
        "key_signature": None, "time_signature": None, "tempo_marking": None,
        "page_kern": page_kern,
        "failed_pages": failed_pages,
        "duplicate_page_warning": duplicate_page_warning,
    }
    if page_errors:
        result["partial_error"] = "; ".join(page_errors)
    return result
