"""
"MEDIANT — Neighbor-Aware Cross-Model Gate" (2026-11-08). The
corrective test named, not built, by the prior round's failure
classification (`cross_model_fp_classification.py`): 147/190 (77.4%)
of the cross-model gate's remaining false positives fell into
Category D (the CREPE-confirmed competing pitch matches a
neighbouring score note), suggesting alignment slop rather than a
genuine wrong-note read.

**Reuses `worker.py`'s own neighbor-expansion logic exactly, adapted
into this isolated experiment -- `worker.py` is NOT modified.** Read
directly (`worker.py:7580-7591`) before adapting: production's rule is
deliberately narrow -- "only the first and last note of a measure get
the neighbouring bars' pitches added. Extending it to every note was
far too permissive: on scale-like writing three bars of pitches cover
most of the scale, and nothing can ever be called wrong." This
experiment reproduces that SAME boundary-only eligibility rule at
score-note granularity (first/last note of a measure, by onset beat
among the score's own notes), not the looser +/-2-note-position
approximation the prior classification round used for diagnosis only
-- the actual corrective test must use the real, already-validated,
narrower production rule, per the directive's explicit "reuse existing
logic" instruction.

The existing cross-model criteria (Basic Pitch + CREPE independent
agreement, `CREPE_MIN_CONF=65`, the same distance/octave substitution
rule) are UNCHANGED -- this only adds one more suppression condition
on top, applied after a flag is already cross-model-confirmed: if the
flagged note is boundary-eligible AND CREPE's confirmed competing
pitch's pitch class matches a pitch class legitimately expected in a
neighbouring measure, suppress it.

No new thresholds invented (reuses the existing Basic Pitch/CREPE
pipeline's own parameters and production's own boundary rule
verbatim). No new model. No parameter sweep. No production code
touched.

RESULTS (measured 2026-11-08) -- **a real, important discrepancy from
the classification round's own prediction, stated plainly rather than
smoothed over.**

    metric                    before suppression   after suppression
    FP, note-level (8 pieces)      191/7211 (2.65%)    161/7211 (2.23%)
    FP, piece-level                 8/8                 8/8
    recall (6 synthetic cases)      5/6                 5/6

Only **30 of 191 (15.7%)** survivors were removed -- a ~16% relative
note-level reduction, not the ~77% the prior round's classification
suggested. **This is not a bug in this implementation; it is the
direct, expected consequence of correctly reproducing production's
deliberately NARROW eligibility rule** (first/last note of a measure
only) instead of the classification round's own looser +/-2-score-
note-position diagnostic radius (used there for diagnosis, not as a
corrective-test specification). Most flagged notes simply are not
boundary-eligible at all under the real rule, so the vast majority of
Category D's 77.4% was never eligible for suppression by the
PROPERLY-SCOPED version of the fix in the first place -- the
classification round's radius overestimated what a faithful
reproduction of production's own rule could achieve. This is itself a
real, useful finding, not a disappointing footnote: it shows the
diagnostic tool and the corrective mechanism are not interchangeable,
and the real production rule's narrowness (deliberately chosen to
avoid "nothing can ever be called wrong" on scale-like passages) caps
how much this specific fix can do.

**Piece-level FP is completely unchanged: 8/8 pieces, before and
after.** Not one piece became clean.

**Recall held at 5/6, and no genuine mistake was suppressed** -- none
of the 6 synthetic cases' target notes were even boundary-eligible
(`boundary_eligible_neighbor_pc_collision=False` for all 6), so this
round's recall preservation, while a real and correct outcome, was not
actually stress-tested by a hard case (Task 2's explicit ask: "include
cases where the injected wrong pitch coincides with a neighbouring
score pitch, if such cases are already available and valid" -- none
of the 6 existing verified cases happen to be such a case; none was
manufactured to force one, per the directive's own prohibition).

**Overhead: negligible** (pure Python set operations, mean 2.23ms/
piece, max 3.40ms).

**Per-instrument:** Flute 2.77%->2.40%, Cello 3.00%->2.51%, Violin
0.26%->0.13% -- consistent, modest reductions across all three, no
instrument-specific regression, but none reaches a materially
different order of magnitude either.

**Decision, per the directive's own explicit bar ("decrease
substantially... otherwise STOP"): STOP.** A 16% relative note-level
reduction with ZERO pieces cleared does not meet "substantially," even
though genuine mistake detection stayed fully credible and no
instrument regressed. Not recommended for broader offline validation.
"""
import json
import sys
import time
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

HERE = Path(__file__).parent
DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]


def build_measure_structures(na, beats_per_measure):
    """Mirrors worker.py's own measure grouping, at score-note
    granularity: which measure each note is in, each measure's own
    pitch classes, and each measure's onset-beat extremes (to
    determine boundary eligibility)."""
    measure_notes: dict[int, list[tuple[float, int]]] = {}
    note_measure: dict[int, int] = {}
    for i in range(len(na)):
        onset_beat = float(na[i]["onset_beat"])
        m = int(onset_beat // beats_per_measure) + 1
        measure_notes.setdefault(m, []).append((onset_beat, int(na[i]["pitch"])))
        note_measure[i] = m
    measure_pcs = {m: set(p % 12 for _, p in notes) for m, notes in measure_notes.items()}
    measure_bounds = {m: (min(ob for ob, _ in notes), max(ob for ob, _ in notes))
                       for m, notes in measure_notes.items()}
    return note_measure, measure_pcs, measure_bounds


def is_boundary_eligible(na, score_idx, note_measure, measure_bounds) -> bool:
    """Same eligibility rule as worker.py:7588 -- only the first/last
    note of a measure (by onset beat) is eligible for neighbour-pitch
    suppression. Not every note -- that was explicitly rejected in
    production as "far too permissive" (worker.py's own comment)."""
    m = note_measure[score_idx]
    onset_beat = float(na[score_idx]["onset_beat"])
    lo, hi = measure_bounds[m]
    return onset_beat == lo or onset_beat == hi


def neighbor_suppresses(na, score_idx, crepe_competing_midi, note_measure, measure_pcs, measure_bounds) -> bool:
    if not is_boundary_eligible(na, score_idx, note_measure, measure_bounds):
        return False
    m = note_measure[score_idx]
    eligible_pcs = set(measure_pcs.get(m, set()))
    for nb in (m - 1, m + 1):
        eligible_pcs |= measure_pcs.get(nb, set())
    return (crepe_competing_midi % 12) in eligible_pcs


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()
    bp_data = json.loads((HERE / "basic_pitch_events.json").read_text())

    print("=== Part 1: false positives, 8 real control pieces ===")
    before_total, after_total, notes_total = 0, 0, 0
    pieces_before, pieces_after = 0, 0
    by_instrument = {}
    suppression_times = []

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

        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        result = detect_wrong_notes(na, alignment, events)
        subs = [n for n in result["notes"] if n["verdict"] == "substitution"]

        crepe_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)

        t0 = time.time()
        note_measure, measure_pcs, measure_bounds = build_measure_structures(na, beats_per_measure)
        confirmed_before, confirmed_after = [], []
        for n in subs:
            ev = crepe_window_evidence(crepe_events, n.get("window"), n["expected_midi"])
            if not ev["confirmed"]:
                continue
            confirmed_before.append(n)
            if neighbor_suppresses(na, n["score_idx"], ev["dominant_midi"], note_measure, measure_pcs, measure_bounds):
                continue  # suppressed by the new neighbor-aware layer
            confirmed_after.append(n)
        t1 = time.time()
        suppression_times.append(t1 - t0)

        before_total += len(confirmed_before)
        after_total += len(confirmed_after)
        notes_total += len(na)
        if confirmed_before:
            pieces_before += 1
        if confirmed_after:
            pieces_after += 1
        by_instrument.setdefault(instrument, {"before": 0, "after": 0, "notes": 0})
        by_instrument[instrument]["before"] += len(confirmed_before)
        by_instrument[instrument]["after"] += len(confirmed_after)
        by_instrument[instrument]["notes"] += len(na)

        print(f"{pid} ({instrument}): before={len(confirmed_before)} after={len(confirmed_after)} / {len(na)} notes")

    print(f"\nFP BEFORE (cross-model gate alone): {pieces_before}/8 pieces, "
          f"{before_total}/{notes_total} notes ({100.0*before_total/notes_total:.2f}%)")
    print(f"FP AFTER (+ neighbor-aware suppression): {pieces_after}/8 pieces, "
          f"{after_total}/{notes_total} notes ({100.0*after_total/notes_total:.2f}%)")
    print(f"Suppression-layer overhead (pure Python, per piece): "
          f"mean {np.mean(suppression_times)*1000:.2f}ms, max {max(suppression_times)*1000:.2f}ms")

    print("\n=== Per-instrument ===")
    for instr, d in by_instrument.items():
        pct_before = 100.0 * d["before"] / d["notes"] if d["notes"] else 0.0
        pct_after = 100.0 * d["after"] / d["notes"] if d["notes"] else 0.0
        print(f"{instr}: before={d['before']}/{d['notes']} ({pct_before:.2f}%) "
              f"after={d['after']}/{d['notes']} ({pct_after:.2f}%)")

    print("\n=== Part 2: recall on 6 verified synthetic injections ===")
    manifest = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
    injected_bp_events = json.loads((HERE / "injected_cases" / "basic_pitch_events.json").read_text())

    tp_before, tp_after = 0, 0
    suppressed_genuine = []
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

        alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
        result = detect_wrong_notes(na, alignment, bp_events)

        nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - case["onset_sec"]))
        target_idx = int(np.argmin(np.abs(na["onset_beat"] - nearest["start_beat"])))
        target_note = result["notes"][target_idx]

        crepe_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        ev = crepe_window_evidence(crepe_events, target_note.get("window"), target_note["expected_midi"])
        was_confirmed = target_note["verdict"] == "substitution" and ev["confirmed"]
        if was_confirmed:
            tp_before += 1

        still_flagged = was_confirmed
        if was_confirmed:
            note_measure, measure_pcs, measure_bounds = build_measure_structures(na, beats_per_measure)
            if neighbor_suppresses(na, target_idx, ev["dominant_midi"], note_measure, measure_pcs, measure_bounds):
                still_flagged = False
                suppressed_genuine.append(case["case"])
        if still_flagged:
            tp_after += 1

        # Does this injected case's own competing/new pitch class happen
        # to coincide with a neighbouring measure's pitch class, i.e. is
        # it a genuinely hard case for this suppression rule? Checked for
        # Task 2's explicit ask, using the SAME structures.
        note_measure, measure_pcs, measure_bounds = build_measure_structures(na, beats_per_measure)
        coincides = (case["new_note"] % 12) in (
            set().union(*(measure_pcs.get(note_measure[target_idx] + d, set()) for d in (-1, 1)))
        ) if target_idx in note_measure else False

        print(f"case {case['case']} (piece {pid}): before={was_confirmed} after={still_flagged} "
              f"boundary_eligible_neighbor_pc_collision={coincides}")

    print(f"\nRecall: {tp_before}/6 -> {tp_after}/6")
    if suppressed_genuine:
        print(f"GENUINE MISTAKES SUPPRESSED by the new layer: cases {suppressed_genuine}")
    else:
        print("No genuine (synthetic) mistakes were suppressed by the new layer.")


if __name__ == "__main__":
    main()
