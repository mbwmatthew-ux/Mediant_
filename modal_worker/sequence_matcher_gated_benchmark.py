"""
"MEDIANT — Next Development Round" (2026-11-11), Task 3: the single
targeted, evidence-based improvement selected from this week's own
investigation history, not a new architecture.

Starting point (already measured, not re-litigated): `sequence_matcher_
benchmark.py`'s own 4-way comparison (2026-11-08) found candidate D
(`sequence_error_matcher.align_sequences`) has the best recall of any
candidate tested (6/6) but a HIGHER false-positive rate (3.51%) than
candidate C (2.61%) — explicitly because D has "no cross-model
suppression layer on top" (that file's own stated reason for its STOP
decision). Candidate C's suppression layer (`cross_model_fp_
classification.crepe_window_evidence`, built for candidate B) was never
applied to D — this script is exactly that missing combination, nothing
else. No new model, no new threshold, no cost-model change to D's own
DP (`sequence_error_matcher.py` is imported unmodified). This is the
narrowest test implied directly by D's own already-recorded weakness.

Candidate E = D's substitutions, each additionally required to pass the
SAME confirmation `crepe_window_evidence` already uses for B->C: a
confident (conf>=65) CREPE event inside the matched performed event's
own [time_sec, end_sec] window that itself disagrees with the expected
pitch. D's MatchOp doesn't carry a window field directly, but it does
carry perf_idx, which indexes the SAME `build_performed_events(events)`
list `sequence_matcher_benchmark.py` already builds — so the window is
derived from already-existing data, not invented.

Reuses, unmodified: `sequence_matcher_benchmark.build_score_notes`,
`build_performed_events`, `run_candidate_D`, `DEV_PIECES`; `cross_model_
fp_classification.crepe_window_evidence`; `sequence_error_matcher.
align_sequences`. Same 8 real MusicNet control pieces + same 6 verified
synthetic injections every round this week has used. No production
code touched; `worker.py` imported read-only the same way every sibling
script this week already does.

Usage:
    python sequence_matcher_gated_benchmark.py
(same isolated real-audio-stack venv as every sibling script; data
expected at ~/.cache/mediant_validation/{data,visual_corpus}/)
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import load_rows
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from cross_model_fp_classification import crepe_window_evidence, pc_match, NEIGHBOR_RADIUS
from sequence_matcher_benchmark import (
    build_score_notes, build_performed_events, run_candidate_D, DEV_PIECES,
)

HERE = Path(__file__).parent
DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")


def gate_candidate_D(d_result, performed_events, crepe_events):
    """Candidate E: D's own substitutions, confirmed only if CREPE's own
    window read also disagrees with the expected pitch — the exact gate
    candidate C already applies to candidate B, applied here to D for
    the first time."""
    confirmed = []
    for op in d_result["substitutions"]:
        pe = performed_events[op.perf_idx] if op.perf_idx is not None else None
        window = (pe.time_sec, pe.end_sec) if pe is not None else None
        ev = crepe_window_evidence(crepe_events, window, op.expected_midi)
        if ev["confirmed"]:
            confirmed.append(op)
    return confirmed


def suppress_neighbor_pitch_class(d_result, na):
    """Candidate F: D's own substitutions, suppressing one whose PLAYED
    pitch class matches a neighbouring score note's pitch class within
    +/-NEIGHBOR_RADIUS positions -- the exact mechanism cross_model_fp_
    classification.py's own "Decision" section named as the smallest
    next test ("extend the gate... do not confirm a flag if the
    competing pitch's pitch class matches a NEIGHBOURING score note's")
    but explicitly did not build. Unlike candidate E, this does NOT
    require any CREPE corroboration at all -- it only consults the
    score's own neighbouring notes and D's own played_midi, so it
    cannot reintroduce the CREPE-window-dependency failure mode that
    cost candidate E half its recall."""
    kept = []
    for op in d_result["substitutions"]:
        lo, hi = max(0, op.score_idx - NEIGHBOR_RADIUS), min(len(na), op.score_idx + NEIGHBOR_RADIUS + 1)
        neighbor_midis = [int(na[j]["pitch"]) for j in range(lo, hi) if j != op.score_idx]
        if any(pc_match(op.played_midi, nb) for nb in neighbor_midis):
            continue  # suppressed: likely alignment/neighbour-bleed, not a genuine wrong note
        kept.append(op)
    return kept


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()
    bp_data = json.loads((HERE / "basic_pitch_events.json").read_text())

    print("=== Part 1: false positives on 8 real control pieces, D vs E (D+CREPE-gate) vs F (D+neighbor-suppress) ===")
    totals = {k: {"fp": 0, "pieces_flagged": 0} for k in "DEF"}
    notes_total = 0
    by_instrument = {k: {} for k in "DEF"}

    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        events = bp_data[pid]["events"]

        wav_bytes = (DATA / "audio" / f"{pid}.wav").read_bytes()
        audio, sr = sf.read(str(DATA / "audio" / f"{pid}.wav"))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        crepe_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)

        d_result = run_candidate_D(na, alignment, events, beats_per_measure)
        performed_events = build_performed_events(events)
        e_confirmed = gate_candidate_D(d_result, performed_events, crepe_events)
        f_kept = suppress_neighbor_pitch_class(d_result, na)

        totals["D"]["fp"] += len(d_result["substitutions"])
        totals["D"]["pieces_flagged"] += 1 if d_result["substitutions"] else 0
        totals["E"]["fp"] += len(e_confirmed)
        totals["E"]["pieces_flagged"] += 1 if e_confirmed else 0
        totals["F"]["fp"] += len(f_kept)
        totals["F"]["pieces_flagged"] += 1 if f_kept else 0

        notes_total += len(na)
        for k, fp in (("D", len(d_result["substitutions"])), ("E", len(e_confirmed)), ("F", len(f_kept))):
            by_instrument[k].setdefault(instrument, {"fp": 0, "notes": 0})
            by_instrument[k][instrument]["fp"] += fp
            by_instrument[k][instrument]["notes"] += len(na)

        print(f"{pid} ({instrument}): D_sub={len(d_result['substitutions'])} "
              f"E_confirmed={len(e_confirmed)} F_kept={len(f_kept)} / {len(na)} notes")

    print(f"\n=== Summary (8 pieces, {notes_total} notes) ===")
    for k in "DEF":
        fp = totals[k]["fp"]
        pct = 100.0 * fp / notes_total
        print(f"{k}: {totals[k]['pieces_flagged']}/8 pieces flagged, {fp}/{notes_total} notes ({pct:.2f}%)")

    print("\n=== Per-instrument ===")
    for k in "DEF":
        for instr, d in by_instrument[k].items():
            pct = 100.0 * d["fp"] / d["notes"] if d["notes"] else 0.0
            print(f"{k} {instr}: {d['fp']}/{d['notes']} ({pct:.2f}%)")

    print("\n=== Part 2: recall + localization, 6 verified synthetic injections, D vs E vs F ===")
    manifest = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
    injected_bp_events = json.loads((HERE / "injected_cases" / "basic_pitch_events.json").read_text())

    recall = {k: 0 for k in "DEF"}
    localized = {k: 0 for k in "DEF"}
    for case in manifest:
        pid = case["piece"]
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        ground_truth = load_ground_truth_with_end_sec(DATA / "labels" / f"{pid}.csv")

        wav_bytes = Path(case["wav_path"]).read_bytes()
        audio, sr = sf.read(Path(case["wav_path"]))
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        bp_events = injected_bp_events[str(case["case"])]

        crepe_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)

        nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - case["onset_sec"]))
        target_idx = int(np.argmin(np.abs(na["onset_beat"] - nearest["start_beat"])))
        true_measure = int(float(na[target_idx]["onset_beat"]) // beats_per_measure) + 1

        d_result = run_candidate_D(na, alignment, bp_events, beats_per_measure)
        performed_events = build_performed_events(bp_events)
        e_confirmed = gate_candidate_D(d_result, performed_events, crepe_events)
        f_kept = suppress_neighbor_pitch_class(d_result, na)

        d_hit_op = next((o for o in d_result["substitutions"] if o.score_idx == target_idx), None)
        d_hit = d_hit_op is not None
        if d_hit:
            recall["D"] += 1
            if d_hit_op.measure == true_measure:
                localized["D"] += 1

        e_hit_op = next((o for o in e_confirmed if o.score_idx == target_idx), None)
        e_hit = e_hit_op is not None
        if e_hit:
            recall["E"] += 1
            if e_hit_op.measure == true_measure:
                localized["E"] += 1

        f_hit_op = next((o for o in f_kept if o.score_idx == target_idx), None)
        f_hit = f_hit_op is not None
        if f_hit:
            recall["F"] += 1
            if f_hit_op.measure == true_measure:
                localized["F"] += 1

        print(f"case {case['case']} (piece {pid}, true_measure={true_measure}): D={d_hit} E={e_hit} F={f_hit}")

    print(f"\nRecall out of 6: D={recall['D']} E={recall['E']} F={recall['F']}")
    print(f"Correct-measure localization among detections: "
          f"D={localized['D']}/{recall['D']} E={localized['E']}/{recall['E']} F={localized['F']}/{recall['F']}")


if __name__ == "__main__":
    main()
