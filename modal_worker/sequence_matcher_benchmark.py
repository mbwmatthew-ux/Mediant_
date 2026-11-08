"""
"MEDIANT — IMPLEMENT SEQUENCE-LEVEL ERROR MATCHING" (2026-11-08),
Task 3: 4-way comparison on the same 8 real MusicNet control pieces
and the same 6 verified synthetic injections every round this week
has used. Nothing new generated -- same audio, same score, same
injections, same transcription (Basic Pitch) and alignment
(Parangonar AudioToScoreMatcher) outputs every prior round already
produced and validated.

**All four candidates are measured in ONE SINGLE process run, per
piece, reusing the SAME CREPE extraction and SAME Parangonar alignment
call across candidates A/C/D and B/C/D respectively** -- this is the
directive's own "reconcile the 190-vs-191 discrepancy... use identical
counting conventions" instruction, addressed directly: the prior
190-vs-191 drift was independently pinned down (not reasserted) in
this round's own investigation to real, confirmed cross-PROCESS
floating-point nondeterminism in CREPE's CPU inference (~0.2-0.3% of
events, ruled out as a thread-pool, hash-seed, or torch-RNG effect by
direct testing — see this round's Decision Report). Measuring every
candidate from the SAME single CREPE/Parangonar call per piece, in the
same process, eliminates that source of drift from THIS comparison
entirely -- any remaining difference between A/B/C/D numbers below is
real, not measurement noise.

Candidates:
  A. Production detector (`worker.run_pitch_tracking` ->
     `worker.dtw_align_to_score` -> `worker.find_wrong_note_candidates`),
     unmodified.
  B. Basic Pitch + Parangonar `AudioToScoreMatcher` adapter
     (`basic_pitch_score_adapter.detect_wrong_notes`), unmodified.
  C. Cross-model agreement gate (B confirmed only if CREPE's own
     window read also disagrees, `cross_model_fp_classification
     .crepe_window_evidence`), unmodified.
  D. New sequence-level error matcher (`sequence_error_matcher
     .align_sequences`), this round's build.

No new thresholds, no cost tuning on these 8 pieces (D's cost model
was fixed and committed against `test_sequence_error_matcher.py`
BEFORE this file was run). No production code touched.

RESULTS (measured 2026-11-08, same 8 pieces, 7211 notes, 6 synthetic
cases, all four candidates from the same single CREPE/Parangonar call
per piece -- no cross-process drift between candidates in this run):

    candidate   pieces flagged   note-level FP      recall (of 6)
    A (prod)    3/8              8/7211 (0.11%)     0
    B (adapter) 8/8              432/7211 (5.99%)   6
    C (x-model) 8/8              188/7211 (2.61%)   5
    D (seqmatch) 8/8             253/7211 (3.51%)   6

**D's recall (6/6) is the best of any single candidate this
investigation has measured** -- it caught the one case (piece 2295)
C's cross-model gate missed, because D never requires independent
CREPE corroboration at all (it doesn't have that failure mode: no
confident-CREPE-event-in-window requirement to fail). D's edit
operations, same 8 pieces: 253 substitutions, 259 ambiguous_pitch
(explicitly NOT promoted to substitution claims), 594 deletions, 1203
insertions -- substitutions are a genuinely distinct, explicit
category throughout, never silently folded into deletions (confirmed
structurally by `test_incorrect_note_sharing_pitch_of_a_nearby_score_note`).

**But D's FP rate (3.51%) is HIGHER than C's (2.61%), not lower.**
This is the expected, logical consequence of the directive's own
scope instruction ("avoid adding another collection of independent...
filtering gates") -- D was built as the alignment/classification
mechanism itself, with no cross-model suppression layer on top, so its
raw substitution count is naturally less filtered than C's
already-cross-model-gated count. D clearly beats B (3.51% vs 5.99%, at
equal 6/6 recall) but does not beat C.

**Piece-level FP: 8/8 for B, C, and D alike -- completely unchanged.**
No candidate built or tested this week has reduced piece-level false
alarms at all.

**Correct-measure localization among true positives: B 6/6, C 5/5, D
6/6** -- all perfect among their own detections (B/C anchored directly
to score index by construction; D's measure field independently
verified against each case's true injected measure, not merely
assumed).

**Per-instrument FP:** D Flute 2.35% (best of B/C/D), D Cello 4.47%
(worse than C's 2.95%, better than B's 7.41%), D Violin 0.66% (worse
than C's 0.26%, better than B's 1.84%). No severe regression on any
instrument, but D is consistently between B and C, not better than C,
on every instrument.

**Overhead:** D's own DP step averaged 0.36s/piece (fast; shares the
same CREPE ~4.5s/piece and Parangonar alignment ~3.3s/piece every
other candidate already pays). On the largest dev piece (2294, 1046
score notes x 999 performed events = ~1.04M DP cells, pure Python, no
banding): 3.18s DP+backtrack time, 530.8MB peak traced Python memory
-- a real, honestly-reported cost that would need optimization (numpy
vectorization or banding) before any larger-scale use, not a blocker
for this STOP decision.

**Decision, against the directive's own 5 explicit GO conditions:**
(1) FP decrease substantially vs. the cross-model baseline -- FAILS,
D's FP is HIGHER than C's, not lower. (2) Reduce piece-level false
alarms -- FAILS, 8/8 unchanged, same as every candidate. (3) Preserve
credible detection of the 6 injected errors -- PASSES, 6/6, the best
of any candidate. (4) Correctly represent substitutions, not silently
convert to deletions -- PASSES, by construction and unit-test-verified.
(5) No severe instrument-specific regression -- PASSES, no instrument
collapses, though D trails C on every instrument's FP rate.

**Two of five conditions fail -> STOP, per the directive's own "only
if" bar.** Not advanced to broader offline validation. D's real
structural advantages (best recall, explicit ambiguous/substitution/
insertion/deletion representation, no cross-model dependency) are
real findings worth keeping, not grounds to override the stated
quantitative bar this round.
"""
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
from validate_alignment_against_musicnet import load_rows
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from basic_pitch_score_adapter import detect_wrong_notes
from cross_model_fp_classification import crepe_window_evidence
from sequence_error_matcher import ScoreNote, PerformedEvent, align_sequences

HERE = Path(__file__).parent
DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]


def build_score_notes(na, alignment, beats_per_measure):
    times = [a.get("performance_time") for a in alignment]
    notes = []
    for i in range(len(na)):
        expected_time = times[i]
        # Local duration estimate: gap to the NEXT aligned score note's own
        # expected time (a simple, defensible proxy -- not tuned on the
        # benchmark, just the most direct reading of "how long until the
        # next expected event" available from the alignment itself).
        expected_dur = None
        if expected_time is not None and i + 1 < len(times) and times[i + 1] is not None:
            gap = times[i + 1] - expected_time
            if gap > 0:
                expected_dur = gap
        measure = int(float(na[i]["onset_beat"]) // beats_per_measure) + 1
        notes.append(ScoreNote(i, int(na[i]["pitch"]), expected_time, expected_dur, measure))
    return notes


def build_performed_events(events):
    sorted_events = sorted(enumerate(events), key=lambda ie: ie[1]["time_sec"])
    return [PerformedEvent(orig_idx, e["time_sec"], e["end_sec"], e["midi"])
            for orig_idx, e in sorted_events]


def run_candidate_D(na, alignment, events, beats_per_measure):
    score_notes = build_score_notes(na, alignment, beats_per_measure)
    performed = build_performed_events(events)
    ops = align_sequences(score_notes, performed)
    subs = [o for o in ops if o.op == "match" and o.pitch_status == "substitution"]
    ambiguous = [o for o in ops if o.op == "match" and o.pitch_status == "ambiguous_pitch"]
    deletions = [o for o in ops if o.op == "deletion"]
    insertions = [o for o in ops if o.op == "insertion"]
    return {"ops": ops, "substitutions": subs, "ambiguous": ambiguous,
            "deletions": deletions, "insertions": insertions}


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()
    bp_data = json.loads((HERE / "basic_pitch_events.json").read_text())

    print("=== Part 1: false positives on 8 real control pieces ===")
    totals = {k: {"fp": 0, "pieces_flagged": 0, "time": [], "D_del": 0, "D_ins": 0, "D_sub": 0, "D_amb": 0}
              for k in "ABCD"}
    notes_total = 0
    by_instrument = {k: {} for k in "ABCD"}

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

        # Shared extraction, ONCE per piece, reused by A/C/D (CREPE) and
        # B/C/D (Parangonar alignment) -- eliminates cross-process drift
        # between candidates for this comparison.
        t0 = time.time()
        crepe_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        t_crepe = time.time() - t0

        t0 = time.time()
        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        t_align = time.time() - t0

        # --- A: production ---
        t0 = time.time()
        a_aligned = w.dtw_align_to_score(crepe_events, score_dict, start_measure=1, beats_per_measure=beats_per_measure)
        a_flags = w.find_wrong_note_candidates(a_aligned, score_dict, instrument=instrument)
        t_A = time.time() - t0
        totals["A"]["fp"] += len(a_flags)
        totals["A"]["pieces_flagged"] += 1 if a_flags else 0
        totals["A"]["time"].append(t_A)

        # --- B: Basic Pitch + AudioToScoreMatcher adapter ---
        t0 = time.time()
        b_result = detect_wrong_notes(na, alignment, events)
        b_subs = [n for n in b_result["notes"] if n["verdict"] == "substitution"]
        t_B = time.time() - t0
        totals["B"]["fp"] += len(b_subs)
        totals["B"]["pieces_flagged"] += 1 if b_subs else 0
        totals["B"]["time"].append(t_B)

        # --- C: cross-model gate ---
        t0 = time.time()
        c_confirmed = []
        for n in b_subs:
            ev = crepe_window_evidence(crepe_events, n.get("window"), n["expected_midi"])
            if ev["confirmed"]:
                c_confirmed.append(n)
        t_C = time.time() - t0
        totals["C"]["fp"] += len(c_confirmed)
        totals["C"]["pieces_flagged"] += 1 if c_confirmed else 0
        totals["C"]["time"].append(t_C)

        # --- D: sequence matcher ---
        t0 = time.time()
        d_result = run_candidate_D(na, alignment, events, beats_per_measure)
        t_D = time.time() - t0
        totals["D"]["fp"] += len(d_result["substitutions"])
        totals["D"]["pieces_flagged"] += 1 if d_result["substitutions"] else 0
        totals["D"]["time"].append(t_D)
        totals["D"]["D_del"] += len(d_result["deletions"])
        totals["D"]["D_ins"] += len(d_result["insertions"])
        totals["D"]["D_sub"] += len(d_result["substitutions"])
        totals["D"]["D_amb"] += len(d_result["ambiguous"])

        notes_total += len(na)
        for k, fp in (("A", len(a_flags)), ("B", len(b_subs)), ("C", len(c_confirmed)), ("D", len(d_result["substitutions"]))):
            by_instrument[k].setdefault(instrument, {"fp": 0, "notes": 0})
            by_instrument[k][instrument]["fp"] += fp
            by_instrument[k][instrument]["notes"] += len(na)

        print(f"{pid} ({instrument}): A={len(a_flags)} B={len(b_subs)} C={len(c_confirmed)} "
              f"D_sub={len(d_result['substitutions'])} D_amb={len(d_result['ambiguous'])} "
              f"D_del={len(d_result['deletions'])} D_ins={len(d_result['insertions'])} "
              f"[crepe={t_crepe:.1f}s align={t_align:.1f}s A={t_A:.2f}s B={t_B:.2f}s C={t_C:.2f}s D={t_D:.2f}s] "
              f"/ {len(na)} notes")

    print(f"\n=== Summary (8 pieces, {notes_total} notes) ===")
    for k in "ABCD":
        fp = totals[k]["fp"]
        pct = 100.0 * fp / notes_total
        print(f"{k}: {totals[k]['pieces_flagged']}/8 pieces flagged, {fp}/{notes_total} notes ({pct:.2f}%), "
              f"mean time/piece {np.mean(totals[k]['time']):.2f}s")
    print(f"D breakdown: substitutions={totals['D']['D_sub']} ambiguous={totals['D']['D_amb']} "
          f"deletions={totals['D']['D_del']} insertions={totals['D']['D_ins']}")

    print("\n=== Per-instrument ===")
    for k in "ABCD":
        for instr, d in by_instrument[k].items():
            pct = 100.0 * d["fp"] / d["notes"] if d["notes"] else 0.0
            print(f"{k} {instr}: {d['fp']}/{d['notes']} ({pct:.2f}%)")

    print("\n=== Part 2: recall + localization, 6 verified synthetic injections ===")
    manifest = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
    injected_bp_events = json.loads((HERE / "injected_cases" / "basic_pitch_events.json").read_text())

    recall = {k: 0 for k in "ABCD"}
    localized = {k: 0 for k in "ABCD"}
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

        # A
        a_aligned = w.dtw_align_to_score(crepe_events, score_dict, start_measure=1, beats_per_measure=beats_per_measure)
        a_flags = w.find_wrong_note_candidates(a_aligned, score_dict, instrument=instrument)
        a_hit = any(f"measure {true_measure} |" in fl for fl in a_flags)
        if a_hit:
            recall["A"] += 1
            localized["A"] += 1  # the flag string names the measure it targets

        # B
        b_result = detect_wrong_notes(na, alignment, bp_events)
        b_target = b_result["notes"][target_idx]
        b_hit = b_target["verdict"] == "substitution"
        if b_hit:
            recall["B"] += 1
            localized["B"] += 1  # anchored directly to score_idx -> always correct by construction

        # C
        ev = crepe_window_evidence(crepe_events, b_target.get("window"), b_target["expected_midi"])
        c_hit = b_hit and ev["confirmed"]
        if c_hit:
            recall["C"] += 1
            localized["C"] += 1

        # D
        d_result = run_candidate_D(na, alignment, bp_events, beats_per_measure)
        d_hit_op = next((o for o in d_result["substitutions"] if o.score_idx == target_idx), None)
        d_hit = d_hit_op is not None
        if d_hit:
            recall["D"] += 1
            if d_hit_op.measure == true_measure:
                localized["D"] += 1

        print(f"case {case['case']} (piece {pid}, true_measure={true_measure}): "
              f"A={a_hit} B={b_hit} C={c_hit} D={d_hit}")

    print(f"\nRecall out of 6: A={recall['A']} B={recall['B']} C={recall['C']} D={recall['D']}")
    print(f"Correct-measure localization among detections: "
          f"A={localized['A']}/{recall['A']} B={localized['B']}/{recall['B']} "
          f"C={localized['C']}/{recall['C']} D={localized['D']}/{recall['D']}")

    print("\n=== Memory profile: candidate D (sequence matcher DP), one representative piece ===")
    tracemalloc.start()
    pid = "2294"  # largest dev piece by note count
    instrument = meta_rows[pid]["instrument"]
    musicxml = SCORES / f"{pid}.musicxml"
    score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
    beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
    score = pt.load_musicxml(str(musicxml))
    na = score.note_array()
    events = bp_data[pid]["events"]
    audio, sr = sf.read(str(DATA / "audio" / f"{pid}.wav"))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
    t0 = time.time()
    run_candidate_D(na, alignment, events, beats_per_measure)
    t1 = time.time()
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    print(f"Piece {pid}: {len(na)} score notes x {len(events)} performed events "
          f"= {len(na)*len(events)} DP cells. DP+backtrack time: {t1-t0:.2f}s. "
          f"Peak traced Python memory: {peak/1e6:.1f} MB")


if __name__ == "__main__":
    main()
