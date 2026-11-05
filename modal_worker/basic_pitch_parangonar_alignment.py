"""
"MEDIANT — Basic Pitch note-extraction feasibility" (2026-11-04), step 7.

Basic Pitch materially outperformed CREPE on raw note extraction (see
`basic_pitch_vs_crepe_report.py`): note precision 0.796 vs 0.531, recall
0.843 vs 0.706, event over-generation 1.059x vs 1.329x. Per the
directive's stop condition 1, that clears the bar to proceed into
alignment.

Note: Task 1's `parangonar_alignment_experiment.py` used
`pa.AudioToScoreMatcher`, which takes RAW AUDIO (it computes its own
spectrogram internally) -- it cannot consume a pre-extracted note-event
list, so it is not the right reuse target for "feed Basic Pitch's
OUTPUT into Parangonar." Parangonar's symbolic note-to-note matcher,
`pa.AutomaticNoteMatcher(score_note_array, performance_note_array)`, is
the one built for exactly this input shape (a score note array and a
PERFORMANCE note array -- here, Basic Pitch's or CREPE's own extracted
notes standing in for "the performance"). Verified its exact field
requirements directly against parangonar's source (`id`/`onset_sec`/
`duration_sec`/`pitch` for the performance array; `id`/`onset_beat`/
`duration_beat`/`pitch` for the score array) rather than guessing --
`partitura`'s own `note_array()` returns the literal string "None" for
every note's `id` (verified directly), which would silently break the
matcher's id-based bookkeeping, so unique ids are assigned here before
calling it.

Scoring reuses `classify_alignment`/`nearest_ground_truth_measure`
(`validate_alignment_against_musicnet.py`, unmodified) -- the SAME
measure-correctness convention Task 1's Parangonar result and every
other alignment candidate in this investigation used, for direct,
apples-to-apples comparability.

No production code touched. Isolated venv only, $0 cost (CPU-only).

RESULTS (measured 2026-11-04, real MusicNet audio, 8 dev pieces, same
`AutomaticNoteMatcher` fed either Basic Pitch's or CREPE's own notes):

    piece   instr    BP %correct   CREPE %correct
    2202    Flute    89.5%         86.1%
    2203    Flute    77.2%         79.5%   <- only piece where CREPE wins
    2217    Cello    78.0%         51.7%
    2221    Cello    93.1%         76.8%
    2288    Violin   97.5%         91.1%
    2293    Cello    91.3%         73.9%
    2294    Cello    81.5%         76.3%
    2295    Cello    82.0%         71.6%
    AVERAGE          86.3%         75.9%

Basic Pitch's cleaner notes win on 7/8 pieces, often by a wide margin
(2217: +26.3pt; 2293: +17.4pt; 2221: +16.3pt), via the EXACT SAME
symbolic matcher -- confirming the extraction quality difference
translates into a real alignment quality difference, not just a
note-counting artifact. Latency comparable either way (~3-10s/piece,
dominated by the matcher's own DTW passes, not by which note source
feeds it).

**But both still trail Task 1's raw-audio `AudioToScoreMatcher` result
on these same pieces (avg ~95.6%, measured 2026-11-01).** Working
directly on the continuous audio signal remains more robust for
ALIGNMENT than any discrete-note-based symbolic matcher, regardless of
which note-extraction front-end feeds it. This is a real, useful
negative result on its own: cleaner notes help the symbolic approach
substantially, but don't close the gap to the existing best alignment
method.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import (
    load_ground_truth, classify_alignment, nearest_ground_truth_measure, load_rows,
)

DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]


def build_score_note_array(na):
    sna = np.zeros(len(na), dtype=[("id", "U20"), ("onset_beat", "f4"),
                                     ("duration_beat", "f4"), ("pitch", "i4")])
    sna["id"] = [f"s{i}" for i in range(len(na))]
    sna["onset_beat"] = na["onset_beat"]
    sna["duration_beat"] = na["duration_beat"]
    sna["pitch"] = na["pitch"]
    return sna


def build_performance_note_array(events):
    events = sorted(events, key=lambda e: e["time_sec"])
    pna = np.zeros(len(events), dtype=[("id", "U20"), ("onset_sec", "f4"),
                                         ("duration_sec", "f4"), ("pitch", "i4"),
                                         ("velocity", "i4")])
    pna["id"] = [f"p{i}" for i in range(len(events))]
    pna["onset_sec"] = [e["time_sec"] for e in events]
    pna["duration_sec"] = [max(0.01, e["end_sec"] - e["time_sec"]) for e in events]
    pna["pitch"] = [e["midi"] for e in events]
    pna["velocity"] = 64
    return pna


def score_alignment(alignment, sna, pna, na, ground_truth, beats_per_measure):
    perf_onset = {pid: onset for pid, onset in zip(pna["id"], pna["onset_sec"])}
    score_idx_by_id = {sid: i for i, sid in enumerate(sna["id"])}

    counts = {"correct": 0, "off_by_one": 0, "wrong": 0, "unmatched": 0}
    for a in alignment:
        if a["label"] != "match":
            continue
        i = score_idx_by_id[a["score_id"]]
        onset_beat = float(na[i]["onset_beat"])
        true_measure = int(onset_beat // beats_per_measure) + 1
        pred_time = perf_onset.get(a["performance_id"])
        predicted_measure = (
            nearest_ground_truth_measure(pred_time, ground_truth, beats_per_measure)
            if pred_time is not None else None
        )
        counts[classify_alignment(predicted_measure, true_measure)] += 1
    n_matched = sum(counts.values())
    n_deleted = sum(1 for a in alignment if a["label"] == "deletion")
    counts["unmatched"] += n_deleted
    n = n_matched + n_deleted
    return {"counts": counts, "n": n, "pct_correct": 100.0 * counts["correct"] / n if n else 0.0}


def main():
    bp_data = json.loads((Path(__file__).parent / "basic_pitch_events.json").read_text())
    crepe_data = json.loads((Path(__file__).parent / "crepe_events.json").read_text())
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    matcher = pa.AutomaticNoteMatcher()

    print(f"{'piece':6} {'instr':8} | {'BP n':5} {'BP %correct':12} {'BP ins':6} {'BP del':6} | "
          f"{'CR n':5} {'CR %correct':12} {'CR ins':6} {'CR del':6}")
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        label = DATA / "labels" / f"{pid}.csv"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        ground_truth = load_ground_truth(label)

        score = pt.load_musicxml(str(musicxml))
        na = score.note_array()
        sna = build_score_note_array(na)

        results = {}
        for name, data in [("bp", bp_data), ("crepe", crepe_data)]:
            pna = build_performance_note_array(data[pid]["events"])
            t0 = time.time()
            alignment = matcher(sna, pna)
            elapsed = time.time() - t0
            r = score_alignment(alignment, sna, pna, na, ground_truth, beats_per_measure)
            r["elapsed"] = elapsed
            n_ins = sum(1 for a in alignment if a["label"] == "insertion")
            n_del = sum(1 for a in alignment if a["label"] == "deletion")
            r["insertions"], r["deletions"] = n_ins, n_del
            results[name] = r

        print(f"{pid:6} {instrument:8} | {results['bp']['n']:5} "
              f"{results['bp']['pct_correct']:6.1f}%      {results['bp']['insertions']:6} "
              f"{results['bp']['deletions']:6} | "
              f"{results['crepe']['n']:5} {results['crepe']['pct_correct']:6.1f}%      "
              f"{results['crepe']['insertions']:6} {results['crepe']['deletions']:6} "
              f"[BP {results['bp']['elapsed']:.1f}s, CR {results['crepe']['elapsed']:.1f}s]")


if __name__ == "__main__":
    main()
