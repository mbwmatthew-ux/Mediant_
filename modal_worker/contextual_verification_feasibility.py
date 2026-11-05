"""
"MEDIANT — contextual verification feasibility" (2026-11-05, third
round this week). Read-only feasibility assessment: does CONTEXT
around a flagged note (neighboring expected/performed notes,
overlapping pitch activity, temporal consistency, harmonic
relationships, measure position) distinguish the 6 true positives
from the 432 false positives found in the gate-feasibility round
(`confidence_gate_diagnostic.py`)? That round already ruled out
amplitude and duration (STOP, no credible separation) -- this is a
DIFFERENT, untested axis: contextual/relational properties, not a
per-event scalar.

Disclosure, per the directive's explicit instruction to say so rather
than quietly re-running anything: the per-event IDENTITY (which score
index each of the 432 false positives corresponds to) was never
persisted from the gate-feasibility round -- only aggregate statistics
(min/max/mean amplitude, duration) and the 6 individual true-positive
printouts were kept. Recovering per-event identity to examine context
requires knowing which score note each flag attaches to, which this
script recovers by RE-RUNNING the exact same already-validated,
already-twice-run alignment + adapter pass (`pa.AudioToScoreMatcher` +
`basic_pitch_score_adapter.detect_wrong_notes`, unmodified) -- a
deterministic, CPU-only, $0 computation over data already on disk
(`basic_pitch_events.json`, the cached MusicXML scores, MusicNet
ground truth). No new Basic Pitch extraction, no new audio processing,
no new injections, no new model of any kind. This is the one place
this script does NOT purely read a stored file; everything else below
(score neighbors, performed-event neighbors, overlapping pitch,
harmonic relationships) is computed directly from already-stored raw
data with no re-inference at all.

No production code touched. `worker.py` unaffected.

RESULTS (measured 2026-11-05) -- three contextual properties examined,
one real confound caught and disclosed, no clean/concrete separation
found:

**Overlapping (simultaneous) pitch activity** -- directionally
suggestive, NOT clean: FP 364/432 (84.3%) coincide with another Basic
Pitch event overlapping in time; TP only 3/6 (50%). A real difference
in direction, but half the true positives STILL show overlap -- not a
property that could gate on without losing half the true positives
even in this tiny sample.

**Harmonic relation to a nearby expected pitch** -- the starkest-
looking number, but PARTIALLY CONFOUNDED by how the synthetic test
cases were built, caught and disclosed rather than reported naively:
FP {'fifth/fourth': 219, None: 149, 'octave': 64} (283/432 = 65.5% show
some harmonic relation); TP 0/6 show any. The OCTAVE component of this
(64/432 for FP, 0/6 for TP) is NOT independent evidence --
`inject_audio_mistakes.verify_injection`'s own "unambiguous" gate
(`_expected_pitch_classes_for_measure`, checked directly against its
source) explicitly REJECTS any injection whose substitute pitch CLASS
already matches a nearby expected one, which includes octave-equivalent
substitutes by construction. The 6 true positives are GUARANTEED to
lack this property by the injection methodology's own validity gate,
not by anything about genuine wrong notes in general. The FIFTH/FOURTH
component (219/432 = 50.7% for FP, 0/6 for TP) is NOT directly excluded
by that gate (it only checks exact pitch-class equality, not
fifth/fourth intervals) and is a genuine, if extremely small-sample,
directional observation.

**Temporal consistency (gap to neighbouring performed event)** -- NO
separation. FP gaps range -1.313s to +1.220s (mean -0.06s, 473/856
gaps negative -- i.e. overlapping/out-of-order neighbours). TP gaps
range -0.39s to +0.12s, sitting entirely WITHIN the FP range, no
distinguishing pattern.

**Combined candidate hypothesis** (one property, per the directive):
false positives more often coincide with COMPETING pitch evidence near
the flagged note -- either literally simultaneous (overlap) or
harmonically adjacent (fifth/fourth) -- than the 6 genuine substitutions
examined do. Directionally present across two independent (one
partially confounded) signals, but NOT concrete or clean: 50% of true
positives still show overlap, and n=6 (with one real construction
confound already found and removed from consideration) is nowhere
near enough to fit or trust a rule on. Not implemented -- per the
directive, this round is read-only inspection, not prototyping.
"""
import json
import sys
from collections import Counter
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

HERE = Path(__file__).parent
DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]


def overlapping_pitch_count(events: list[dict], this_event: dict) -> int:
    """How many OTHER Basic Pitch events in this piece overlap in time
    with `this_event`'s [time_sec, end_sec] window -- i.e. does the
    model's own output show more than one pitch active at once here.
    Purely from already-stored event data, no new inference."""
    t0, t1 = this_event["time_sec"], this_event["end_sec"]
    count = 0
    for e in events:
        if e is this_event:
            continue
        if e["time_sec"] < t1 and e["end_sec"] > t0:
            count += 1
    return count


def nearest_neighbors_in_time(sorted_events: list[dict], pos: int) -> tuple[dict | None, dict | None]:
    prev_e = sorted_events[pos - 1] if pos > 0 else None
    next_e = sorted_events[pos + 1] if pos + 1 < len(sorted_events) else None
    return prev_e, next_e


def harmonic_relation(played_midi: int, reference_midis: list[int]) -> str | None:
    """Is played_midi an octave or perfect-5th/4th of any nearby
    EXPECTED pitch (not just the one it's being compared against)?
    Returns a label or None."""
    for ref in reference_midis:
        diff = abs(played_midi - ref) % 12
        if diff == 0 and played_midi != ref:
            return "octave"
        if diff in (7, 5):
            return "fifth/fourth"
    return None


def score_neighbor_midis(na, score_idx: int, radius: int = 2) -> list[int]:
    lo, hi = max(0, score_idx - radius), min(len(na), score_idx + radius + 1)
    return [int(na[j]["pitch"]) for j in range(lo, hi) if j != score_idx]


def inspect_piece(matcher, pid: str, instrument: str, events: list[dict],
                   score_dict: dict, beats_per_measure: int, na) -> list[dict]:
    audio, sr = sf.read(str(DATA / "audio" / f"{pid}.wav"))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
    result = detect_wrong_notes(na, alignment, events)

    # `played_perf_idx` is the ORIGINAL (pre-sort) index into `events`
    # that detect_wrong_notes records; rebuild the same sort it uses
    # internally to find each flagged event's position among its
    # time-ordered neighbours.
    sorted_pairs = sorted(enumerate(events), key=lambda ie: ie[1]["time_sec"])
    orig_to_pos = {orig_idx: pos for pos, (orig_idx, _) in enumerate(sorted_pairs)}
    sorted_events_only = [e for _, e in sorted_pairs]

    rows = []
    for n in result["notes"]:
        if n["verdict"] != "substitution":
            continue
        orig_idx = n["played_perf_idx"]
        pos = orig_to_pos[orig_idx]
        this_event = sorted_events_only[pos]

        prev_e, next_e = nearest_neighbors_in_time(sorted_events_only, pos)
        overlap = overlapping_pitch_count(events, this_event)
        score_idx = n["score_idx"]
        neighbor_midis = score_neighbor_midis(na, score_idx)
        harmonic = harmonic_relation(n["played_midi"], neighbor_midis + [n["expected_midi"]])

        # Temporal consistency: inter-onset interval to the previous
        # PERFORMED event vs. the expected inter-onset interval implied
        # by the previous SCORE note's own beat distance (scaled by
        # this take's own average sec-per-beat, estimated once from the
        # alignment's own first/last performance_time span).
        rows.append({
            "piece": pid, "instrument": instrument, "score_idx": score_idx,
            "measure": int(na[score_idx]["onset_beat"] // beats_per_measure) + 1,
            "expected_midi": n["expected_midi"], "played_midi": n["played_midi"],
            "overlapping_pitch_count": overlap,
            "has_prev_neighbor": prev_e is not None, "has_next_neighbor": next_e is not None,
            "prev_gap_sec": (this_event["time_sec"] - prev_e["end_sec"]) if prev_e else None,
            "next_gap_sec": (next_e["time_sec"] - this_event["end_sec"]) if next_e else None,
            "harmonic_relation": harmonic,
        })
    return rows


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AudioToScoreMatcher()
    bp_data = json.loads((HERE / "basic_pitch_events.json").read_text())

    print("=== False positives: contextual properties (432 distinct events, 8 control pieces) ===")
    all_fp_rows = []
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        events = bp_data[pid]["events"]
        rows = inspect_piece(matcher, pid, instrument, events, score_dict, beats_per_measure, na)
        all_fp_rows.extend(rows)

    print(f"Total FP rows recovered: {len(all_fp_rows)} (expect 432)")

    overlap_counts = Counter(r["overlapping_pitch_count"] > 0 for r in all_fp_rows)
    print(f"FP with >=1 overlapping (simultaneous) Basic Pitch pitch: "
          f"{overlap_counts[True]}/{len(all_fp_rows)}")
    harmonic_counts = Counter(r["harmonic_relation"] for r in all_fp_rows)
    print(f"FP harmonic relation to a nearby expected pitch: {dict(harmonic_counts)}")
    gaps_prev = [r["prev_gap_sec"] for r in all_fp_rows if r["prev_gap_sec"] is not None]
    gaps_next = [r["next_gap_sec"] for r in all_fp_rows if r["next_gap_sec"] is not None]
    print(f"FP gap-to-previous-performed-event (s): min={min(gaps_prev):.3f} "
          f"max={max(gaps_prev):.3f} mean={np.mean(gaps_prev):.3f} median={np.median(gaps_prev):.3f}")
    print(f"FP gap-to-next-performed-event (s): min={min(gaps_next):.3f} "
          f"max={max(gaps_next):.3f} mean={np.mean(gaps_next):.3f} median={np.median(gaps_next):.3f}")
    negative_gaps = sum(1 for g in gaps_prev + gaps_next if g < 0)
    print(f"Negative gaps (overlapping/out-of-order neighboring performed events): "
          f"{negative_gaps}/{len(gaps_prev) + len(gaps_next)}")

    print("\n=== True positives: contextual properties (6 verified injections) ===")
    manifest = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
    injected_events = json.loads((HERE / "injected_cases" / "basic_pitch_events.json").read_text())
    all_tp_rows = []
    for case in manifest:
        pid = case["piece"]
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        events = injected_events[str(case["case"])]
        rows = inspect_piece(matcher, pid, instrument, events, score_dict, beats_per_measure, na)

        ground_truth = load_ground_truth_with_end_sec(DATA / "labels" / f"{pid}.csv")
        nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - case["onset_sec"]))
        target_idx = int(np.argmin(np.abs(na["onset_beat"] - nearest["start_beat"])))
        target_rows = [r for r in rows if r["score_idx"] == target_idx]
        if not target_rows:
            print(f"case {case['case']} (piece {pid}): target note not flagged in this pass "
                  f"(unexpected -- prior round found it flagged; not using this case's context)")
            continue
        r = target_rows[0]
        all_tp_rows.append(r)
        print(f"case {case['case']} (piece {pid}, {instrument}, measure {r['measure']}): "
              f"overlapping_pitch_count={r['overlapping_pitch_count']} "
              f"harmonic_relation={r['harmonic_relation']} "
              f"prev_gap={r['prev_gap_sec']} next_gap={r['next_gap_sec']}")

    tp_overlap = sum(1 for r in all_tp_rows if r["overlapping_pitch_count"] > 0)
    print(f"\nTP with >=1 overlapping pitch: {tp_overlap}/{len(all_tp_rows)}")
    tp_harmonic = Counter(r["harmonic_relation"] for r in all_tp_rows)
    print(f"TP harmonic relation to a nearby expected pitch: {dict(tp_harmonic)}")
    tp_gaps = [r["prev_gap_sec"] for r in all_tp_rows if r["prev_gap_sec"] is not None] + \
              [r["next_gap_sec"] for r in all_tp_rows if r["next_gap_sec"] is not None]
    print(f"TP neighbor gaps (s): {sorted(tp_gaps)}")


if __name__ == "__main__":
    main()
