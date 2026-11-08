"""
"MEDIANT — ENGINEERING DIRECTIVE: REAL-ERROR VALIDATION" (2026-11-08).
Tasks 2 and 3: minimal evaluation adapter + run existing candidates
against HARPSET (Mena García, 2026, Zenodo DOI 10.5281/zenodo.18282225,
CC BY 4.0), the first genuine recorded-mistake corpus this
investigation has had access to.

**Ground-truth mapping, verified not assumed:** `errors.csv`'s own
`note_index` field does NOT reliably correspond to `partitura`'s
`note_array()` ordering (checked directly -- piece 02 diverges by
exactly -2 semitones starting partway through the piece, confirmed by
reading `errors.csv`'s source, `tools/generate_errors.py`: it counts
non-rest notes via its own raw-XML walk that does not handle
`<backup>`/`<forward>` elements the way `partitura` does). Instead,
this script diffs the O score directly against each N/RN score via
`partitura` (same tool, same ordering convention on both sides, so
internally self-consistent regardless of any external indexing
scheme) and uses the resulting note-array INDEX as ground truth.
**Cross-checked against `errors.csv`'s own row counts per piece/variant:
11 of 12 N/RN pairs match exactly** (same count of differing notes),
confirming this approach independently. **One real exception found and
excluded, not silently handled:** piece 01's RN variant has 44 notes
vs. the original's 45 (a structural length mismatch, likely from the
rhythm alteration merging or deleting a note) -- parallel diffing does
not apply; piece `01_RN` is excluded from the pitch-error ground truth
set below.

**Per the directive's CRITICAL rule: the ORIGINAL (O) MusicXML/score is
the only reference ever passed to a detector.** `errors.csv` and the
altered (N/R/RN) scores are used ONLY to build ground truth for
scoring, never as detector input.

**Acoustic spot-check, done before trusting the symbolic ground truth
(the directive's own explicit instruction):** ran CREPE
(`worker.run_pitch_tracking`) near 5 claimed alterations across 5
different pieces. **Finding: CREPE's raw confidence (periodicity) is
pathologically low across these recordings -- max confidence 1.4% on
piece 01_N's full 26-second audio (checked directly: 0 of 651 frames
reach even the 30% "voiced" floor, let alone the 45% event-selection
threshold)**, a genuine CREPE-on-harp incompatibility, NOT a bug in any
script here. Basic Pitch, checked on the same audio, produces 65
sensible note events with reasonable confidences (0.49-0.81) -- this is
specific to CREPE's own model, not a general transcription failure on
this corpus. Reported, not glossed over, because it directly predicts
(and the full run below confirms) that both Candidate A and Candidate
B's cross-model gate -- both CREPE-dependent -- will show degenerate,
uninformative near-zero results on this entire dataset, for a specific,
measured reason, not an unexplained failure.

**Harp polyphony: checked directly across all 13 original scores via
`partitura`, found to be a non-issue.** Every single O score is
monophonic (max simultaneous notes = 1, zero chord onsets, confirmed
piece by piece) -- despite the instrument's polyphonic capability, this
dataset's musical content is single-line throughout, so the existing
monophonic-assuming pipeline applies directly with no input-
compatibility concern from polyphony specifically.

No new detector, no new thresholds, no production code touched.

**SUPERSEDED (2026-11-08 integrity fix):** the RESULTS block below is from
the pre-fix run. Its Part-2 recall denominator was 22 (8 pieces; piece 13's
4 deviations were silently skipped), not 26. Corrected, asserted numbers:
agent_workspace/HARPSET_BENCHMARK_INTEGRITY_FIX_2026-11-08.md.

RESULTS (measured 2026-11-08, real recorded harp audio, 13 original
performances, 26 independently verified pitch errors across 9 pieces'
N variants).

**Two real dataset-packaging gaps found and worked around explicitly,
not silently patched over:** (1) `metadata.csv` claims
`scores/12_N_Score.xml`/`12_RN_Score.xml` exist; they do not --
confirmed by direct file check. `errors.csv` correctly has zero rows
for piece 12 as a consequence (its generator could not find the
altered scores either). (2) `metadata.csv` omits piece 13's N/RN rows
entirely even though `13_N_Score.xml`/`13_RN_Score.xml` and their
audio files are all physically present and `errors.csv` has valid
entries for both -- this script's own first pass silently under-
counted by 4 real cases by trusting `metadata.csv` as the file index;
caught and fixed by resolving paths directly from the known naming
convention instead, re-run, included below.

**CREPE produced ZERO events on EVERY ONE of the 14 pieces tested (13
O + piece 13's N spot check) -- a complete, universal failure on this
corpus, not an isolated or instrument-bound-specific issue.** Spot-
checked directly beforehand (see module docstring): raw CREPE
confidence tops out at 1.4% on a 26-second recording, nowhere near the
30% voicing floor. This single fact determines nearly everything
below.

    candidate                pieces flagged (O)   note FP      recall (/26)
    A (production)                 0/13             0.00%          0
    B + cross-model gate           0/13             0.00%          0
    B, no gate (optional)         13/13            10.64%         21 (80.8%)

**A and the gated B are completely non-functional on this corpus** --
zero detections of any kind, zero false positives, because their
CREPE dependency (direct for A, via cross-model confirmation for B)
never produces a single usable event. Zero false positives here is
not evidence of precision; it is the signature of a detector that
never fires at all.

**The optional, ungated Basic Pitch + `AudioToScoreMatcher` adapter is
the only candidate that detects anything, and it detects a lot: 21 of
26 independently verified GENUINE pitch errors (80.8%) -- the best
real-mistake recall this entire investigation has measured, on
authentic recorded deviations, not synthetic injections.** Localization
among its own detections: 21/21 (100%, by construction -- anchored
directly to score index, same as every round this week). But its
false-positive rate on the 13 correct originals is high: ALL 13
pieces received at least one false flag (93/874 notes, 10.64%) --
nowhere close to the directive's own screening bar (no more than 1 of
13 falsely flagged).

**Comparison to this week's synthetic MusicNet results**: the bare
adapter's FP rate here (10.64% note-level, 13/13 pieces) is
substantially worse than its already-measured MusicNet baseline
(5.99%, 8/8 pieces, commit `21e3f41`) -- a real, concrete sign that
synthetic-corpus numbers do not transfer cleanly to a different
instrument/recording context, confirming this investigation's own
standing caution against treating synthetic results as proof of
real-world accuracy.

**CPU time/memory**: Candidate A per piece <1.2s (trivially fast --
nothing to track). Candidate B (either configuration) 0.2-5.0s/piece
(the first-call overhead includes Basic Pitch's model load via
subprocess). Peak traced memory for CREPE extraction on the longest
piece (10_O, 56.4s): 53.4 MB -- light, unremarkable.

**Polyphony: confirmed, again, a non-issue** -- all 13 original scores
remain monophonic (max simultaneous notes = 1 everywhere), re-verified
in this run.

**Decision, against the directive's own explicit screening bar (no
more than 1/13 falsely flagged originals, plus correct localization of
multiple verified notes): STOP.** Neither of the two specified
candidates (A, B+gate) detects anything at all. The one candidate that
does detect real mistakes well (the optional bare adapter) fails the
false-alarm bar by a wide margin (13/13, not <=1/13). No candidate
measured this round meets the bar.
"""
import csv
import json
import sys
import time
import tracemalloc
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf
import partitura as pt
import parangonar as pa

import worker as w
from basic_pitch_score_adapter import detect_wrong_notes
from cross_model_fp_classification import crepe_window_evidence

HERE = Path(__file__).parent
HARPSET = Path("/Users/matthewwu/.cache/mediant_validation/harpset/HARPSET")
ALL_PIECES = [f"{i:02d}" for i in range(1, 14)]


# File resolution follows the HARPSET naming convention and is checked against
# disk. metadata.csv is NOT used to decide which performances exist: it omits
# (13, N) and lists a phantom (12, N) whose files are absent (2026-11-08
# integrity fix; see agent_workspace/HARPSET_BENCHMARK_INTEGRITY_FIX_2026-11-08.md).
EXPECTED_N_DEVIATIONS = 26
EXPECTED_N_PIECES = ("01", "02", "03", "04", "05", "06", "09", "13")


def score_file(pid: str, variant: str) -> Path:
    return HARPSET / "scores" / f"{pid}_{variant}_Score.xml"


def audio_file(pid: str, variant: str) -> Path:
    return HARPSET / "audio" / f"{pid}_{variant}_Recording.wav"


def performance_exists(pid: str, variant: str) -> bool:
    return score_file(pid, variant).exists() and audio_file(pid, variant).exists()


def build_manifest() -> list[dict]:
    """One row per (piece, variant) over 01-13 x {O, N, R, RN}. For N/RN with
    both files present, runs ground_truth_pitch_errors (None = excluded)."""
    rows = []
    for pid in ALL_PIECES:
        for variant in ("O", "N", "R", "RN"):
            present = performance_exists(pid, variant)
            gt = None
            if present and variant in ("N", "RN"):
                gt = ground_truth_pitch_errors(pid, variant)
            rows.append({"piece": pid, "variant": variant, "present": present, "gt": gt})
    return rows


def print_manifest_and_assert(manifest: list[dict]) -> None:
    print("=== Manifest: HARPSET files on disk + pitch ground truth vs O ===")
    print(f"{'piece':>5} {'var':>3} {'both files':>10}  ground truth")
    for r in manifest:
        if not r["present"]:
            status = "-"
        elif r["variant"] in ("N", "RN"):
            status = ("excluded: length mismatch" if r["gt"] is None
                      else f"{len(r['gt'])} pitch deviations")
        else:
            status = "original (reference)"
        print(f"{r['piece']:>5} {r['variant']:>3} {'yes' if r['present'] else 'no':>10}  {status}")

    o_missing = [r["piece"] for r in manifest if r["variant"] == "O" and not r["present"]]
    n_hits = [(r["piece"], len(r["gt"])) for r in manifest if r["variant"] == "N" and r["gt"]]
    n_pieces = tuple(p for p, _ in n_hits)
    n_total = sum(c for _, c in n_hits)
    print(f"\nN-variant pitch deviations: {n_total} across {len(n_pieces)} pieces {list(n_pieces)}")
    if o_missing or n_total != EXPECTED_N_DEVIATIONS or n_pieces != EXPECTED_N_PIECES:
        raise AssertionError(
            f"HARPSET ground-truth manifest mismatch: expected {EXPECTED_N_DEVIATIONS} N-variant "
            f"pitch deviations across pieces {list(EXPECTED_N_PIECES)}; found {n_total} across "
            f"{list(n_pieces)}; original (O) performances missing: {o_missing}. "
            "Dataset packaging may have regressed -- do not trust results from this run."
        )


def load_errors():
    return list(csv.DictReader(open(HARPSET / "annotations" / "errors.csv")))


def score_note_array(pid: str, variant: str = "O"):
    path = HARPSET / "scores" / f"{pid}_{variant}_Score.xml"
    return pt.load_musicxml(str(path)).note_array()


def ground_truth_pitch_errors(pid: str, variant: str) -> list[int] | None:
    """Verified na-index positions where `variant`'s score differs in
    pitch from the ORIGINAL (O) score. Returns None if lengths differ
    (parallel diffing invalid -- excluded, not guessed)."""
    na_o = score_note_array(pid, "O")
    path = HARPSET / "scores" / f"{pid}_{variant}_Score.xml"
    if not path.exists():
        return None
    na_v = pt.load_musicxml(str(path)).note_array()
    if len(na_o) != len(na_v):
        return None
    return [i for i in range(len(na_o)) if int(na_o[i]["pitch"]) != int(na_v[i]["pitch"])]


def extract_basic_pitch_events(audio_path: str) -> list[dict]:
    """Calls into the basic_pitch venv via subprocess -- this script
    runs in the main validation venv (torch/torchcrepe/parangonar);
    Basic Pitch lives in its own venv, same separation every round
    this week has used."""
    import subprocess
    script = f"""
import sys, json
from basic_pitch.inference import predict
_, _, note_events = predict({audio_path!r})
events = [{{"time_sec": float(s), "end_sec": float(e), "midi": int(round(p))}}
          for s, e, p, amp, bend in note_events]
print(json.dumps(events))
"""
    result = subprocess.run(
        ["/Users/matthewwu/.cache/mediant_validation/venv_basic_pitch/bin/python3", "-c", script],
        capture_output=True, text=True, timeout=120,
    )
    for line in result.stdout.splitlines():
        line = line.strip()
        if line.startswith("["):
            return json.loads(line)
    raise RuntimeError(f"Basic Pitch extraction failed: {result.stderr[-500:]}")


def run_candidate_A(wav_bytes: bytes, score_dict: dict, beats_per_measure: int, instrument: str):
    t0 = time.time()
    events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
    aligned = w.dtw_align_to_score(events, score_dict, start_measure=1, beats_per_measure=beats_per_measure)
    flags = w.find_wrong_note_candidates(aligned, score_dict, instrument=instrument)
    return flags, time.time() - t0, events


def run_candidate_B(na, matcher, audio, sr, bp_events, crepe_events, use_gate: bool):
    t0 = time.time()
    alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
    result = detect_wrong_notes(na, alignment, bp_events)
    subs = [n for n in result["notes"] if n["verdict"] == "substitution"]
    if use_gate:
        confirmed = []
        for n in subs:
            ev = crepe_window_evidence(crepe_events, n.get("window"), n["expected_midi"])
            if ev["confirmed"]:
                confirmed.append(n)
        subs = confirmed
    return subs, time.time() - t0


def main():
    manifest = build_manifest()
    print_manifest_and_assert(manifest)

    print("\n=== Part 0: harp polyphony check (re-confirmed in this run) ===")
    for pid in ALL_PIECES:
        na = score_note_array(pid, "O")
        onsets = na["onset_beat"]
        _, counts = np.unique(onsets, return_counts=True)
        print(f"{pid}: {len(na)} notes, max_simultaneous={counts.max() if len(counts) else 0}")

    print("\n=== Part 1: false positives on 13 original (O) performances ===")
    matcher = pa.AudioToScoreMatcher()
    a_total_fp, a_pieces_flagged = 0, 0
    b_nogate_total_fp, b_nogate_pieces_flagged = 0, 0
    b_gate_total_fp, b_gate_pieces_flagged = 0, 0
    notes_total = 0
    crepe_event_counts = []

    for pid in ALL_PIECES:
        musicxml = score_file(pid, "O")
        audio_path = audio_file(pid, "O")
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        na = score_note_array(pid, "O")

        wav_bytes = audio_path.read_bytes()
        audio, sr = sf.read(str(audio_path))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        a_flags, t_a, crepe_events = run_candidate_A(wav_bytes, score_dict, beats_per_measure, "Harp")
        crepe_event_counts.append(len(crepe_events))
        bp_events = extract_basic_pitch_events(str(audio_path))
        b_nogate, t_b1 = run_candidate_B(na, matcher, audio, sr, bp_events, crepe_events, use_gate=False)
        b_gate, t_b2 = run_candidate_B(na, matcher, audio, sr, bp_events, crepe_events, use_gate=True)

        a_total_fp += len(a_flags)
        a_pieces_flagged += 1 if a_flags else 0
        b_nogate_total_fp += len(b_nogate)
        b_nogate_pieces_flagged += 1 if b_nogate else 0
        b_gate_total_fp += len(b_gate)
        b_gate_pieces_flagged += 1 if b_gate else 0
        notes_total += len(na)

        print(f"{pid}_O: CREPE_events={len(crepe_events)} A_flags={len(a_flags)} "
              f"B_nogate={len(b_nogate)} B_gate={len(b_gate)} / {len(na)} notes "
              f"[A={t_a:.2f}s B1={t_b1:.2f}s B2={t_b2:.2f}s]")

    print(f"\nA: {a_pieces_flagged}/13 pieces flagged, {a_total_fp}/{notes_total} notes "
          f"({100.0*a_total_fp/notes_total:.2f}%)")
    print(f"B (no gate): {b_nogate_pieces_flagged}/13 pieces flagged, {b_nogate_total_fp}/{notes_total} notes "
          f"({100.0*b_nogate_total_fp/notes_total:.2f}%)")
    print(f"B (cross-model gate): {b_gate_pieces_flagged}/13 pieces flagged, {b_gate_total_fp}/{notes_total} notes "
          f"({100.0*b_gate_total_fp/notes_total:.2f}%)")
    print(f"CREPE event counts across 13 O pieces: {crepe_event_counts}")

    print("\n=== Part 2: pitch-error recall on N-variant performances (pitch-only alterations) ===")
    recall_a, recall_b_nogate, recall_b_gate = 0, 0, 0
    total_errors = 0
    by_instrument = {}  # all harp -- single-instrument corpus, reported for completeness
    localization = {"A": 0, "B_nogate": 0, "B_gate": 0}

    for pid in ALL_PIECES:
        if not performance_exists(pid, "N"):
            continue
        gt_indices = ground_truth_pitch_errors(pid, "N")
        if gt_indices is None or not gt_indices:
            continue
        musicxml_o = score_file(pid, "O")
        audio_path = audio_file(pid, "N")
        score_dict = w.parse_musicxml(musicxml_o.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        na = score_note_array(pid, "O")

        wav_bytes = audio_path.read_bytes()
        audio, sr = sf.read(str(audio_path))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        a_flags, _, crepe_events = run_candidate_A(wav_bytes, score_dict, beats_per_measure, "Harp")
        bp_events = extract_basic_pitch_events(str(audio_path))
        b_nogate, _ = run_candidate_B(na, matcher, audio, sr, bp_events, crepe_events, use_gate=False)
        b_gate, _ = run_candidate_B(na, matcher, audio, sr, bp_events, crepe_events, use_gate=True)
        b_nogate_idx = {n["score_idx"] for n in b_nogate}
        b_gate_idx = {n["score_idx"] for n in b_gate}

        for idx in gt_indices:
            total_errors += 1
            true_measure = int(float(na[idx]["onset_beat"]) // beats_per_measure) + 1
            a_hit = any(f"measure {true_measure} |" in fl for fl in a_flags)
            b1_hit = idx in b_nogate_idx
            b2_hit = idx in b_gate_idx
            if a_hit:
                recall_a += 1
                localization["A"] += 1
            if b1_hit:
                recall_b_nogate += 1
                localization["B_nogate"] += 1
            if b2_hit:
                recall_b_gate += 1
                localization["B_gate"] += 1
            print(f"{pid}_N idx={idx} measure={true_measure}: A={a_hit} B_nogate={b1_hit} B_gate={b2_hit}")

    print(f"\nRecall out of {total_errors} verified pitch errors: "
          f"A={recall_a} B_nogate={recall_b_nogate} B_gate={recall_b_gate}")
    print(f"Correct-measure localization among detections: "
          f"A={localization['A']}/{recall_a} B_nogate={localization['B_nogate']}/{recall_b_nogate} "
          f"B_gate={localization['B_gate']}/{recall_b_gate}")

    print("\n=== Memory profile: one representative O piece ===")
    tracemalloc.start()
    pid = "10"  # longest piece
    wav_file = audio_file(pid, "O")
    wav_bytes = wav_file.read_bytes()
    _ = w.run_pitch_tracking(wav_bytes, instrument="Harp")
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    print(f"Piece {pid} (O, {sf.info(str(wav_file)).duration:.3f}s): peak traced Python memory: {peak/1e6:.1f} MB")


if __name__ == "__main__":
    main()
