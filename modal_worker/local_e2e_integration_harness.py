#!/usr/bin/env python3
"""
Local end-to-end integration harness (offline, $0, no Modal / Anthropic /
Gemini / Supabase calls). Chains four already-validated components on ONE
real, verified fixture and checks that their outputs connect:

  Step 1  build_visual_validation_corpus.build_corpus_entry
          -> rendered page PNG + independent ground-truth measures (music21)
  Step 2  page_omr_adapter.score_pages_with_page_omr (production code path)
          -> canonical score dict read from the page image
  Step 3  page_omr_adapter (_ensure_model_loaded / _bytes_to_image /
          deskew_image / run_inference) -> raw kern -> music21 -> MusicXML
          -> partitura note_array (for Parangonar)
  Step 4  Basic Pitch on the real audio, via the subprocess pattern in
          score_conditioned_error_classifier (BP_PY / BP_SCRIPT, reused)
  Step 5  Parangonar AudioToScoreMatcher on the real audio + note_array

Fixture: MusicNet piece 2220, Bach Cello Suite 3 "4. Sarabande", solo cello,
302 s. The page is rendered FROM the same MIDI that the audio's labels were
derived from, so score and audio carry the same musical content by
construction.

Wrong-note findings are NOT computed here. Every structured entry carries
the literal "unavailable - not independently validated" (see WRONG_NOTE_
FINDING). The experimental Basic-Pitch wrong-note detectors are not imported.

Usage (main validation venv):
    /Users/matthewwu/.cache/mediant_validation/venv/bin/python \\
        modal_worker/local_e2e_integration_harness.py [--out-dir DIR]
"""
from __future__ import annotations

import argparse
import bisect
import csv
import json
import os
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import music21
import partitura as pt
import parangonar as pa

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_visual_validation_corpus as bvc  # Step 1 (reused, not reimplemented)
import page_omr_adapter as pom                 # Steps 2-3 (read-only use)
from score_conditioned_error_classifier import BP_PY, BP_SCRIPT  # Step 4 (reused)

FIX_ROOT = Path("/Users/matthewwu/.cache/mediant_validation/musicnet_raw")
MIDI_PATH = FIX_ROOT / "musicnet_midis/Bach/2220_cs3-4sar.mid"
WAV_PATH = FIX_ROOT / "musicnet/train_data/2220.wav"
LABELS_PATH = FIX_ROOT / "musicnet/train_labels/2220.csv"
METADATA_PATH = FIX_ROOT / "musicnet_metadata.csv"
PIECE_ID = "2220"

WRONG_NOTE_FINDING = "unavailable — not independently validated"
FRAME_RATE = 50          # Parangonar default spectrogram frame rate
DEFAULT_MAX_BP = 64.0    # Parangonar AudioToScoreMatcher default
ONSET_WIN_SEC = 0.10     # Basic Pitch onset-evidence window (+/- )
ONSET_THRESHOLD = 0.30   # pre-declared Basic Pitch onset activation threshold


def _rss_mb() -> float:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss / (1024 * 1024) if sys.platform == "darwin" else rss / 1024


def _load_metadata_row() -> dict:
    with open(METADATA_PATH) as f:
        for row in csv.DictReader(f):
            if row["id"] == PIECE_ID:
                return row
    raise RuntimeError(f"metadata row {PIECE_ID} not found")


def _load_audio() -> tuple[np.ndarray, int]:
    audio, sr = sf.read(str(WAV_PATH))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio.astype(np.float32), int(sr)


def _midi_name(midi: int) -> str:
    return music21.pitch.Pitch(midi=int(midi)).nameWithOctave


def _check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f" -- {detail}" if detail else ""))
    return ok


# ---------------------------------------------------------------------------
# Step 1 - ground truth + rendered page
# ---------------------------------------------------------------------------
def step1_ground_truth(out_dir: Path, row: dict) -> dict:
    t0 = time.time()
    entry = bvc.build_corpus_entry(PIECE_ID, str(MIDI_PATH), row, out_dir)
    if entry is None:
        raise RuntimeError("build_corpus_entry returned None (render failed)")
    entry["elapsed_sec"] = time.time() - t0
    return entry


# ---------------------------------------------------------------------------
# Step 2 - production page-omr entry point, called directly
# ---------------------------------------------------------------------------
def step2_page_omr(page_bytes: bytes) -> tuple[dict, float]:
    t0 = time.time()
    res = pom.score_pages_with_page_omr([(page_bytes, "image/png")], start_measure=1)
    return res, time.time() - t0


# ---------------------------------------------------------------------------
# Step 3 - same internal calls score_pages_with_page_omr makes, but keeping
# the raw kern so partitura can read it. Deterministic (greedy decoding), so
# the kern equals the one Step 2 read; the consistency check below asserts it.
# ---------------------------------------------------------------------------
def step3_note_array(page_bytes: bytes) -> tuple[np.ndarray, str, float]:
    t0 = time.time()
    pom._ensure_model_loaded()
    image = pom._bytes_to_image(page_bytes, "image/png")
    deskewed, _angle = pom.deskew_image(image)
    raw_kern, _elapsed = pom.run_inference(deskewed)
    score = music21.converter.parse(raw_kern, format="humdrum")
    fd, tmp_path = tempfile.mkstemp(suffix=".musicxml")
    os.close(fd)
    try:
        score.write("musicxml", fp=tmp_path)
        note_array = pt.load_musicxml(tmp_path).note_array()
    finally:
        os.remove(tmp_path)
    return note_array, raw_kern, time.time() - t0


# ---------------------------------------------------------------------------
# Step 4 - Basic Pitch via the existing subprocess pattern (BP_PY/BP_SCRIPT)
# ---------------------------------------------------------------------------
def step4_basic_pitch(work_dir: Path, wav_path: Path = WAV_PATH, tag: str = "2220") -> dict:
    t0 = time.time()
    out = work_dir / f"{tag}_bp.npz"
    result = subprocess.run(
        [BP_PY, "-c", BP_SCRIPT, str(wav_path), str(out)],
        capture_output=True, text=True, timeout=600,
    )
    if "OK" not in result.stdout:
        raise RuntimeError(f"Basic Pitch failed: {result.stderr[-800:]}")
    d = np.load(out)
    return {
        "onset": d["onset"], "times": d["times"],
        "elapsed_sec": time.time() - t0, "bp_predict_sec": float(d["bp_seconds"]),
    }


# ---------------------------------------------------------------------------
# Step 5 - Parangonar
# ---------------------------------------------------------------------------
def max_bp_for_piece(audio_sec: float, note_array: np.ndarray) -> float:
    """
    Parangonar's max_bp is a fixed cap on the tracked beat period in
    spectrogram frames (default 64 = 1.28 s/beat at 50 fps). Its own initial
    beat-period estimate is audio_frames / score_beat_span (matcher source,
    audio_matchers.py `bp_average`), which can exceed that cap for a slow
    performance. Bound: never below the default, and always above the
    initial estimate computed from this piece's own audio length and score
    span. Uses no ground-truth labels.
    """
    span = float(note_array["onset_beat"].max() - note_array["onset_beat"].min())
    initial_bp = audio_sec * FRAME_RATE / span
    return max(DEFAULT_MAX_BP, initial_bp)


def step5_align(note_array, audio: np.ndarray, sr: int, max_bp: float | None):
    matcher = pa.AudioToScoreMatcher(max_bp=max_bp) if max_bp else pa.AudioToScoreMatcher()
    t0 = time.time()
    alignment = matcher(audio, note_array, sample_rate=sr)
    elapsed = time.time() - t0
    times = np.array([float(a["performance_time"]) for a in alignment], dtype=float)
    return alignment, times, elapsed


def bp_onset_support(pitches, times, bp: dict) -> dict:
    """
    Fraction of aligned notes whose pitch has a Basic Pitch onset activation
    (>= ONSET_THRESHOLD) within +/- ONSET_WIN_SEC of the aligned time, versus
    the same measure after shuffling the times across notes (null).
    Independent of Parangonar: only uses Basic Pitch's onset matrix.
    """
    def rate(times_arr):
        hits = []
        for p, tt in zip(pitches, times_arr):
            b = int(p) - 21
            if b < 0 or b >= bp["onset"].shape[1]:
                continue
            lo = bisect.bisect_left(bp["times"], tt - ONSET_WIN_SEC)
            hi = bisect.bisect_right(bp["times"], tt + ONSET_WIN_SEC)
            if hi <= lo:
                hits.append(False)
                continue
            hits.append(float(bp["onset"][lo:hi, b].max()) >= ONSET_THRESHOLD)
        return float(np.mean(hits)) if hits else float("nan")
    aligned = rate(times)
    rng = np.random.default_rng(0)
    null = float(np.nanmean([rate(rng.permutation(times)) for _ in range(5)]))
    evidence = (aligned - null) >= 0.30 and aligned >= 0.50
    return {"aligned_rate": aligned, "null_rate": null, "has_audio_evidence": bool(evidence)}


def alignment_health(times: np.ndarray, audio_sec: float, n_expected: int) -> dict:
    """
    The matcher exposes no confidence score. This is a structural guard only:
    it flags results that are obviously degenerate, not results that are
    merely wrong.
    """
    if times.size != n_expected:
        return {"degenerate": True, "reason": f"{times.size} times for {n_expected} notes"}
    d = np.diff(times)
    nonmono = int((d < -1e-9).sum())
    unique_frac = len(np.unique(np.round(times, 3))) / max(1, times.size)
    span_frac = float(times.max() - times.min()) / audio_sec
    out_of_range = bool(np.any(times < 0) or np.any(times > audio_sec + 1.0))
    degenerate = unique_frac < 0.5 or span_frac < 0.5 or nonmono > 0 or out_of_range
    reasons = []
    if unique_frac < 0.5:
        reasons.append(f"only {unique_frac:.2%} unique times")
    if span_frac < 0.5:
        reasons.append(f"times span only {span_frac:.2%} of audio")
    if nonmono:
        reasons.append(f"{nonmono} decreasing steps")
    if out_of_range:
        reasons.append("times outside audio range")
    return {
        "degenerate": degenerate, "unique_frac": unique_frac, "span_frac": span_frac,
        "nonmonotonic_steps": nonmono, "reason": "; ".join(reasons) or "none",
    }


# ---------------------------------------------------------------------------
# Structured analysis object (Task 2)
# ---------------------------------------------------------------------------
def gt_bar_length(gt_measures: list) -> float:
    extents = []
    for m in gt_measures:
        ends = [n["beat"] - 1 + n["duration_beats"] for n in m["notes"]]
        extents.append(max(ends) if ends else 0.0)
    if not extents or max(extents) - min(extents) > 1e-6:
        raise RuntimeError(f"non-uniform measure lengths: {sorted(set(extents))}")
    return extents[0]


def build_structured(note_array, times, gt_measures, bar_len, instrument) -> list[dict]:
    entries = []
    for i in range(len(note_array)):
        onset = float(note_array["onset_beat"][i])
        midi = int(note_array["pitch"][i])
        entries.append({
            "index": i,
            "measure": int(onset // bar_len) + 1,
            "pitch_midi": midi,
            "pitch_name": _midi_name(midi),
            "score_time_beat": onset,
            "audio_time_sec": float(times[i]),
            "instrument": instrument,
            "wrong_note_finding": WRONG_NOTE_FINDING,
        })
    return entries


def ground_truth_pitch_list(gt_measures) -> list[tuple[int, float, str]]:
    """(measure, beat-in-measure, pitch name) for every pitched GT note, in order."""
    out = []
    for m in gt_measures:
        for n in m["notes"]:
            if not n["is_rest"]:
                out.append((m["number"], n["beat"], n["pitch"]))
    return out


def check_pitch_and_octave(po_measures, gt_measures) -> tuple[bool, dict]:
    """Check 1: page-omr pitch names vs independent GT, by measure + position."""
    gt_by_m = {m["number"]: [n for n in m["notes"]] for m in gt_measures}
    po_by_m = {m["number"]: [n for n in m["notes"]] for m in po_measures}
    total_pitched = sum(1 for m in gt_measures for n in m["notes"] if not n["is_rest"])
    matched = 0
    mismatches = []
    count_mismatch_measures = []
    for mnum, gt_notes in gt_by_m.items():
        po_notes = po_by_m.get(mnum, [])
        if len(po_notes) != len(gt_notes):
            count_mismatch_measures.append(mnum)
        for pos, g in enumerate(gt_notes):
            if g["is_rest"]:
                continue
            if pos < len(po_notes) and not po_notes[pos]["is_rest"] and po_notes[pos]["pitch"] == g["pitch"]:
                matched += 1
            else:
                got = po_notes[pos]["pitch"] if pos < len(po_notes) else None
                mismatches.append((mnum, pos, g["pitch"], got))
    details = {
        "matched": matched, "total": total_pitched,
        "measures_with_different_note_count": count_mismatch_measures,
        "first_mismatches": mismatches[:5],
    }
    return matched == total_pitched and not count_mismatch_measures, details


def check_ordering(note_array, gt_measures, bar_len) -> tuple[bool, dict]:
    """Check 2: note_array order vs GT order (sorted by absolute onset, then pitch)."""
    gt = ground_truth_pitch_list(gt_measures)
    gt_abs = sorted(((m - 1) * bar_len + (b - 1), music21.pitch.Pitch(p).midi) for m, b, p in gt)
    gt_seq = [_midi_name(p) for _, p in gt_abs]
    na_pairs = sorted(zip(note_array["onset_beat"].tolist(), note_array["pitch"].tolist()))
    na_seq = [_midi_name(p) for _, p in na_pairs]
    ok = na_seq == gt_seq
    diffs = [i for i, (a, b) in enumerate(zip(na_seq, gt_seq)) if a != b]
    as_given = [_midi_name(p) for p in note_array["pitch"].tolist()]
    details = {
        "n_note_array": len(na_seq), "n_gt": len(gt_seq),
        "first10_note_array": na_seq[:10], "first10_gt": gt_seq[:10],
        "first_diff_index": diffs[0] if diffs else None,
        "note_array_as_given_sorted_by_onset": bool(np.all(np.diff(note_array["onset_beat"]) >= 0)),
        "as_given_equals_gt": as_given == gt_seq,
    }
    return ok, details


def check_measures(entries, gt_measures, note_array, bar_len) -> tuple[bool, dict]:
    """Check 3 + measure mapping verified against GT by beat position."""
    gt_numbers = [m["number"] for m in gt_measures]
    used = sorted({e["measure"] for e in entries})
    sequential = gt_numbers == list(range(1, len(gt_numbers) + 1))
    # Note-level entries only exist for measures with pitched notes. Measures that are
    # rest-only in the GT are listed explicitly, not counted as gaps.
    pitched_measures = {m["number"] for m in gt_measures if any(not n["is_rest"] for n in m["notes"])}
    rest_only = sorted(set(gt_numbers) - pitched_measures)
    no_gaps = set(used) <= set(gt_numbers) and set(used) == pitched_measures
    gt_index = {}
    for m in gt_measures:
        for n in m["notes"]:
            if not n["is_rest"]:
                gt_index.setdefault((m["number"], round(n["beat"], 3), n["pitch"]), 0)
                gt_index[(m["number"], round(n["beat"], 3), n["pitch"])] += 1
    verified = 0
    unverified = []
    for e in entries:
        beat_in_bar = round(e["score_time_beat"] % bar_len + 1, 3)
        key = (e["measure"], beat_in_bar, e["pitch_name"])
        if gt_index.get(key, 0) > 0:
            verified += 1
        else:
            unverified.append((e["index"], e["measure"], beat_in_bar, e["pitch_name"]))
    details = {
        "gt_measure_count": len(gt_numbers), "gt_numbers_sequential_1_to_N": sequential,
        "measures_used_by_entries": f"{used[0]}..{used[-1]} ({len(used)} distinct)" if used else "none",
        "entry_measures_match_pitched_gt_measures": no_gaps,
        "rest_only_gt_measures": rest_only, "bar_len_beats": bar_len,
        "entries_verified_against_gt_by_beat": verified, "entries_total": len(entries),
        "first_unverified": unverified[:5],
    }
    return sequential and no_gaps and verified == len(entries), details


def _label_errors(entries, times, label_onsets) -> dict | None:
    errs = []
    for e, tt in zip(entries, times):
        key = (round(e["score_time_beat"], 2), e["pitch_midi"])
        if key in label_onsets:
            errs.append(abs(float(tt) - label_onsets[key]))
    if not errs:
        return None
    errs = np.array(errs)
    return {"matched_notes": int(errs.size), "median_sec": float(np.median(errs)),
            "p90_sec": float(np.percentile(errs, 90)), "frac_over_1s": float(np.mean(errs > 1.0)),
            "frac_within_0.25s": float(np.mean(errs <= 0.25))}


def check_times(entries, times, label_onsets, bp: dict | None, audio_sec: float) -> tuple[bool, dict]:
    """Check 4: monotonic audio time, range, spot checks, and two independent cross-checks."""
    t = times
    d = np.diff(t)
    nonmono = int((d < -1e-9).sum())
    details = {
        "min_sec": float(t.min()), "max_sec": float(t.max()),
        "nonmonotonic_steps": nonmono, "zero_steps": int((d == 0).sum()),
        "distinct_times": len(np.unique(np.round(t, 3))),
    }
    spots = [0, len(entries) // 2, len(entries) - 1]
    details["spot_checks"] = [
        {"index": i, "beat": entries[i]["score_time_beat"], "pitch": entries[i]["pitch_name"],
         "audio_sec": round(float(t[i]), 3)} for i in spots
    ]
    # MusicNet label cross-check (ground truth onset times for matching (beat, pitch)).
    lab = _label_errors(entries, t, label_onsets)
    if lab:
        lab["of"] = len(entries)
        details["labels"] = lab
    # Basic Pitch onset evidence at each aligned time (same pitch bin), vs a shuffled null.
    if bp is not None:
        details["basic_pitch_onset_support"] = bp_onset_support([e["pitch_midi"] for e in entries], t, bp)
    # Label-free reference: time proportional to score beat over the whole audio.
    uniform = np.array([e["score_time_beat"] for e in entries]) * audio_sec / max(
        1e-9, max(e["score_time_beat"] for e in entries) - min(e["score_time_beat"] for e in entries))
    details["uniform_tempo_baseline_abs_err_sec"] = _label_errors(entries, uniform, label_onsets)
    return nonmono == 0, details


def check_instrument(entries) -> tuple[bool, dict]:
    vals = sorted({e["instrument"] for e in entries})
    return vals == ["Cello"], {"values": vals}


def check_mapping_integrity(entries, note_array) -> tuple[bool, dict]:
    idx = [e["index"] for e in entries]
    ok = len(idx) == len(note_array) and sorted(idx) == list(range(len(note_array)))
    return ok, {"entries": len(idx), "note_array_len": len(note_array),
                "unique_indices": len(set(idx)), "duplicates": len(idx) - len(set(idx))}


def check_wrong_note_literal(entries) -> tuple[bool, dict]:
    vals = {e["wrong_note_finding"] for e in entries}
    return vals == {WRONG_NOTE_FINDING}, {"distinct_values": sorted(vals)}


def degenerate_cases(note_array, max_bp: float | None, work_dir: Path) -> list[dict]:
    """
    Check 7b: mismatched audio through the same final matcher config. Each case is
    flagged if EITHER the structural guard fires OR Basic Pitch finds no onset
    evidence at the aligned times (the matcher itself gives no signal).
    """
    out = []
    silence = np.zeros(int(302 * 44100), dtype=np.float32)
    noise = np.random.default_rng(0).normal(0, 0.05, int(302 * 44100)).astype(np.float32)
    other, other_sr = sf.read(str(FIX_ROOT / "musicnet/train_data/2186.wav"))
    if other.ndim > 1:
        other = other.mean(axis=1)
    cases = [
        ("silence_302s", silence, 44100),
        ("white_noise_302s", noise, 44100),
        ("other_piece_2186_wav", other.astype(np.float32), int(other_sr)),
    ]
    for name, audio, sr in cases:
        rec = {"case": name, "audio_sec": len(audio) / sr}
        try:
            wav = work_dir / f"{name}.wav"
            sf.write(str(wav), audio, sr)
            _al, times, elapsed = step5_align(note_array, audio, sr, max_bp)
            rec["elapsed_sec"] = elapsed
            rec["times_min_max"] = (float(times.min()), float(times.max()))
            rec["health"] = alignment_health(times, len(audio) / sr, len(note_array))
            bp = step4_basic_pitch(work_dir, wav, name)
            rec["bp"] = bp_onset_support(note_array["pitch"].tolist(), times, bp)
            rec["flagged"] = bool(rec["health"]["degenerate"] or not rec["bp"]["has_audio_evidence"])
            rec["crashed"] = False
        except Exception as e:  # noqa: BLE001 - reporting what actually happened
            rec["crashed"] = True
            rec["error"] = f"{type(e).__name__}: {e}"
            rec["flagged"] = True
        out.append(rec)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-dir", default=None, help="scratch directory (default: a new tempdir)")
    args = parser.parse_args()
    work = Path(args.out_dir) if args.out_dir else Path(tempfile.mkdtemp(prefix="mediant_e2e_"))
    work.mkdir(parents=True, exist_ok=True)
    results = {}
    timings = {}
    t_all = time.time()
    row = _load_metadata_row()
    instrument = row["ensemble"].replace("Solo ", "")  # "Solo Cello" -> "Cello"
    print(f"Fixture: MusicNet {PIECE_ID} | {row['composer']} {row['composition']} {row['movement']} | "
          f"{row['ensemble']} | {row['seconds']} s")
    print(f"Scratch dir: {work}")

    # ---- Step 1 ----
    print("\n== Step 1: render page + independent ground truth ==")
    gt = step1_ground_truth(work, row)
    timings["step1_render_sec"] = gt["elapsed_sec"]
    gt_measures = gt["measures"]
    print(f"  pages={gt['n_pages']} measures={len(gt_measures)} time_signature={gt['time_signature']}")
    if gt["n_pages"] != 1:
        print("  harness supports one-page fixtures only; stopping")
        return 2
    page_bytes = (work / f"{PIECE_ID}_page1.png").read_bytes()
    bar_len = gt_bar_length(gt_measures)
    gt_pitched = sum(1 for m in gt_measures for n in m["notes"] if not n["is_rest"])
    print(f"  GT pitched notes={gt_pitched}  uniform bar length={bar_len} beats")

    # ---- Step 2 ----
    print("\n== Step 2: page-omr score reading (production entry point) ==")
    po, timings["step2_pageomr_sec"] = step2_page_omr(page_bytes)
    print(f"  source={po.get('source')} error={po.get('error')} partial_error={po.get('partial_error')} "
          f"measures={len(po['measures'])} time_signature={po.get('time_signature')} "
          f"key_signature={po.get('key_signature')}")
    results["step2_source_ok"] = po.get("source") == "page_omr" and not po.get("error")

    # ---- Step 3 ----
    print("\n== Step 3: raw kern -> music21 -> MusicXML -> partitura note_array ==")
    note_array, raw_kern, timings["step3_kern_bridge_sec"] = step3_note_array(page_bytes)
    kern_measures, kern_err = pom.kern_to_measures(raw_kern)
    consistent = (not kern_err) and [
        [n["pitch"] for n in m["notes"] if not n["is_rest"]] for m in kern_measures
    ] == [[n["pitch"] for n in m["notes"] if not n["is_rest"]] for m in po["measures"]]
    print(f"  note_array notes={len(note_array)} fields={list(note_array.dtype.names)[:7]}...")
    print(f"  kern read in Step 3 equals Step 2 pitch content: {consistent}")
    results["step3_consistent"] = consistent
    results["step3_n_notes"] = len(note_array)

    # ---- Step 4 ----
    print("\n== Step 4: Basic Pitch on the real audio (subprocess, venv_basic_pitch) ==")
    bp = step4_basic_pitch(work)
    timings["step4_basic_pitch_sec"] = bp["elapsed_sec"]
    print(f"  onset activation matrix={bp['onset'].shape} predict={bp['bp_predict_sec']:.2f}s")

    # ---- Step 5 ----
    audio, sr = _load_audio()
    audio_sec = len(audio) / sr
    print(f"\n== Step 5: Parangonar alignment (audio {audio_sec:.1f} s @ {sr} Hz) ==")
    print("  Run A: default matcher bounds (max_bp=64, before fix)")
    _alA, timesA, elA = step5_align(note_array, audio, sr, None)
    healthA = alignment_health(timesA, audio_sec, len(note_array))
    print(f"    {elA:.1f}s  range {timesA.min():.2f}-{timesA.max():.2f}s  "
          f"distinct={len(np.unique(np.round(timesA,3)))}  degenerate={healthA['degenerate']} ({healthA['reason']})")
    max_bp = max_bp_for_piece(audio_sec, note_array)
    print(f"  Run B: max_bp={max_bp:.1f} (bound from this piece's audio length and score span)")
    alignment, times, elB = step5_align(note_array, audio, sr, max_bp)
    timings["step5_parangonar_sec"] = elB
    healthB = alignment_health(times, audio_sec, len(note_array))
    print(f"    {elB:.1f}s  range {times.min():.2f}-{times.max():.2f}s  "
          f"distinct={len(np.unique(np.round(times,3)))}  degenerate={healthB['degenerate']} ({healthB['reason']})")
    bpA = bp_onset_support(note_array["pitch"].tolist(), timesA, bp)
    print(f"    Basic Pitch onset support: aligned {bpA['aligned_rate']:.1%} vs null {bpA['null_rate']:.1%}")
    results["alignment_before_degenerate"] = healthA["degenerate"]
    bpB = bp_onset_support(note_array["pitch"].tolist(), times, bp)
    print(f"    Basic Pitch onset support: aligned {bpB['aligned_rate']:.1%} vs null {bpB['null_rate']:.1%}")
    results["alignment_after_degenerate"] = healthB["degenerate"]

    # ---- Task 2 structured object ----
    print("\n== Task 2: structured analysis object and property checks ==")
    entries = build_structured(note_array, times, gt_measures, bar_len, instrument)
    label_onsets = {}
    with open(LABELS_PATH) as f:
        for r in csv.DictReader(f):
            key = (round(float(r["start_beat"]), 2), int(r["note"]))
            label_onsets.setdefault(key, int(r["start_time"]) / sr)
    checks = {}
    print("  1. Pitch and octave (page-omr vs independent GT, by measure + position)")
    checks[1] = check_pitch_and_octave(po["measures"], gt_measures)
    _report(checks[1], "pitched notes matched {matched}/{total}", extra_keys=["measures_with_different_note_count"])
    print("  2. Note ordering (note_array vs GT, sorted by absolute onset then pitch)")
    checks[2] = check_ordering(note_array, gt_measures, bar_len)
    _report(checks[2], f"first10 note_array={checks[2][1]['first10_note_array']} gt={checks[2][1]['first10_gt']}")
    print("  3. Measure numbering and mapping")
    checks[3] = check_measures(entries, gt_measures, note_array, bar_len)
    _report(checks[3], "entries verified vs GT {entries_verified_against_gt_by_beat}/{entries_total}; "
            "GT sequential={gt_numbers_sequential_1_to_N}; used={measures_used_by_entries}")
    print("  4. Score-time to audio-time mapping")
    checks[4] = check_times(entries, times, label_onsets, bp, audio_sec)
    _report(checks[4], f"monotonic steps violated={checks[4][1]['nonmonotonic_steps']}, "
            f"range {checks[4][1]['min_sec']:.2f}-{checks[4][1]['max_sec']:.2f}s")
    for s in checks[4][1]["spot_checks"]:
        print(f"       spot: idx {s['index']} beat {s['beat']} {s['pitch']} -> {s['audio_sec']} s")
    if "labels" in checks[4][1]:
        L = checks[4][1]["labels"]
        print(f"       MusicNet label cross-check: {L['matched_notes']}/{L['of']} notes, median |err| "
              f"{L['median_sec']:.3f}s, p90 {L['p90_sec']:.3f}s, "
              f"{L['frac_over_1s']:.1%} over 1 s, {L['frac_within_0.25s']:.1%} within 0.25 s")
        U = checks[4][1]["uniform_tempo_baseline_abs_err_sec"]
        print(f"       uniform-tempo baseline (no audio): median |err| {U['median_sec']:.3f}s, "
              f"p90 {U['p90_sec']:.3f}s, {U['frac_over_1s']:.1%} over 1 s")
    if "basic_pitch_onset_support" in checks[4][1]:
        B = checks[4][1]["basic_pitch_onset_support"]
        print(f"       Basic Pitch onset support: aligned {B['aligned_rate']:.1%} vs shuffled null "
              f"{B['null_rate']:.1%}")
    print("  5. Instrument metadata")
    checks[5] = check_instrument(entries)
    _report(checks[5], f"values={checks[5][1]['values']}")
    print("  6. Mapping integrity (no missing or duplicate entries)")
    checks[6] = check_mapping_integrity(entries, note_array)
    _report(checks[6], f"entries={checks[6][1]['entries']} unique={checks[6][1]['unique_indices']}")
    print("  7. Confidence signal and degenerate-input behaviour")
    keys = sorted(alignment[0].keys())
    has_conf = any("conf" in k.lower() for k in keys)
    print(f"       matcher per-note keys: {keys}; any confidence field: {has_conf}")
    print("       matcher return_everything exposes DP internals (cost matrix, path), not a per-note confidence")
    checks[7] = (not has_conf, {"keys": keys})
    print(f"  [{'INFO'}] 7a. no per-note confidence signal exists (limitation, reported, not fabricated)")
    print("  7b. Deliberately mismatched audio through the same final matcher config:")
    deg = degenerate_cases(note_array, max_bp, work)
    for rec in deg:
        if rec.get("crashed"):
            print(f"       {rec['case']}: CRASH {rec['error']}")
        else:
            h = rec["health"]
            print(f"       {rec['case']}: {rec['elapsed_sec']:.1f}s range {rec['times_min_max'][0]:.2f}-"
                  f"{rec['times_min_max'][1]:.2f}s structural_degenerate={h['degenerate']} ({h['reason']}); "
                  f"BP onset support aligned {rec['bp']['aligned_rate']:.1%} vs null {rec['bp']['null_rate']:.1%} "
                  f"-> flagged={rec['flagged']}")
    results["degenerate_cases_flagged"] = all(rec["flagged"] for rec in deg)
    results["degenerate_structural_only"] = [rec["case"] for rec in deg
                                              if not rec.get("crashed") and not rec["health"]["degenerate"]]

    # ---- Task 3: shape compatibility with worker.py expectations (read, not called) ----
    print("\n== Task 3: schema compatibility with worker.py (dtw_align_to_score, find_wrong_note_candidates) ==")
    numbers = [m["number"] for m in po["measures"]]
    numbering_ok = numbers == list(range(1, len(numbers) + 1))
    po_pairs = sorted((m["number"], n["pitch"]) for m in po["measures"] for n in m["notes"] if not n["is_rest"])
    ent_pairs = sorted((e["measure"], e["pitch_name"]) for e in entries)
    pairs_ok = po_pairs == ent_pairs
    roundtrip = all(music21.pitch.Pitch(e["pitch_name"]).midi == e["pitch_midi"] for e in entries)
    shape_ok = numbering_ok and pairs_ok and roundtrip
    print(f"  page-omr canonical dict (production shape): {len(numbers)} measures, numbers 1..{numbers[-1]} "
          f"sequential={numbering_ok}")
    print(f"  (measure, pitch) pairs in structured object == page-omr pitched notes: {pairs_ok} "
          f"({len(ent_pairs)} vs {len(po_pairs)})")
    print(f"  pitch name -> MIDI round trip for all {len(entries)} entries: {roundtrip}")
    print(f"  page-omr time_signature={po.get('time_signature')} (dtw_align_to_score takes beats_per_measure from the caller)")
    results["schema_ok"] = shape_ok
    results["wrong_note_literal_ok"] = check_wrong_note_literal(entries)[0]
    print(f"  wrong_note_finding on every entry = '{WRONG_NOTE_FINDING}': {results['wrong_note_literal_ok']}")

    # ---- Summary ----
    all_pass = all(checks[k][0] for k in checks) and results["schema_ok"] and results["wrong_note_literal_ok"]
    print("\n== Summary ==")
    for k in sorted(checks):
        print(f"  Task 2 check {k}: {'PASS' if checks[k][0] else 'FAIL'}")
    print(f"  Task 3 schema: {'PASS' if results['schema_ok'] else 'FAIL'}; "
          f"wrong-note literal: {'PASS' if results['wrong_note_literal_ok'] else 'FAIL'}")
    print(f"  Degenerate inputs flagged: {results['degenerate_cases_flagged']}")
    print(f"  Alignment before fix degenerate={results['alignment_before_degenerate']}, "
          f"after fix degenerate={results['alignment_after_degenerate']}")
    timings["total_sec"] = time.time() - t_all
    timings["peak_rss_mb"] = _rss_mb()
    print("  timings: " + ", ".join(f"{k}={v:.1f}" for k, v in timings.items()))
    out_json = work / "structured_analysis.json"
    out_json.write_text(json.dumps({"entries": entries}, indent=1, default=str))
    print(f"  structured object written to {out_json}")
    print(f"\nOVERALL: {'PASS' if all_pass else 'FAIL'}")
    return 0 if all_pass else 1


def _report(check, msg_fmt: str, extra_keys: list | None = None) -> None:
    ok, details = check
    try:
        msg = msg_fmt.format(**details)
    except (KeyError, IndexError):
        msg = msg_fmt
    print(f"       {msg}")
    for k in extra_keys or []:
        print(f"       {k}: {details[k]}")
    print(f"       -> {'PASS' if ok else 'FAIL'}")


if __name__ == "__main__":
    sys.exit(main())
