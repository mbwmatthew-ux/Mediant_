"""
Chained end-to-end benchmark for docs/superpowers/plans/2026-10-30-audio-
pipeline-benchmark.md Task 3. Runs the FREE half of the real production
chain (run_pitch_tracking -> dtw_align_to_score) against synthetically
injected mistakes (inject_audio_mistakes.py), to find out whether a given
injected case is even detectable before Task 4 spends anything on the
Gemini/Claude leg.

APPROVAL GATE: this file deliberately stops after the free legs. A
`run_paid_legs` function belongs in a SEPARATE follow-up task, dispatched
only after the owner explicitly approves a spending cap for it (spec rule
10; this plan's Global Constraints) -- do not add Gemini/Claude calls to
this file without that separate approval.

Same category as validate_alignment_against_musicnet.py: not part of the
Modal image, needs the shared validation venv's torch/torchcrepe/librosa/
soundfile/music21 stack, run against the same /tmp/musicnet_data/ layout.

Final whole-branch review fix (2026-10-30): the original version of this
function called `load_ground_truth` (no "end_sec" key) and fed its rows
straight into `inject_mistake` (which requires `target["end_sec"]") --
this raised KeyError on any real MusicNet piece; it only ever "worked" in
the mocked unit test because the test's fake ground truth happened to
include "end_sec" even though the mocked function it stood in for
doesn't produce it. It also hardcoded `instrument="Violin"` for every
piece regardless of the real piece's instrument. Both are fixed below:
`load_ground_truth_with_end_sec` (moved here from run_task3_benchmark.py,
which now imports it FROM this module instead of defining its own copy,
to avoid a circular import between the two files) reads MusicNet's own
end_time column directly; the per-piece instrument is looked up via the
same metadata-CSV mechanism (`load_rows` + MusicNet's "ensemble" column
-> INSTRUMENT_MAP, both from validate_alignment_against_musicnet.py) that
already worked for the real run reported in task-3-report.md, rather
than inventing a new one. run_task3_benchmark.py's `run_one_condition`
now calls `run_free_legs` for the three injected-mistake conditions
instead of reimplementing the same run_pitch_tracking -> dtw_align_to_
score chain; see that file's module docstring for the re-run confirmation
that this refactor did not change any reported number.
"""
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
from validate_alignment_against_musicnet import (  # noqa: E402
    midi_score_to_dict, load_rows)
from inject_audio_mistakes import inject_mistake  # noqa: E402

MUSICNET_SR = 44100


def load_ground_truth_with_end_sec(label_csv_path: Path) -> list[dict]:
    """
    validate_alignment_against_musicnet.load_ground_truth gives onset_sec/
    note/start_beat but deliberately not end_sec (it never needed it).
    inject_mistake requires end_sec to know each note's audio window.
    Reads MusicNet's own end_time column directly (same sample-index-at-
    44100Hz convention start_time already uses) rather than modifying the
    existing, already-validated loader. (Moved here from
    run_task3_benchmark.py during the final whole-branch review fix so
    that both this module's run_free_legs and that module's
    run_one_condition can share one implementation.)
    """
    rows = []
    with open(label_csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append({
                "onset_sec": int(row["start_time"]) / MUSICNET_SR,
                "end_sec": int(row["end_time"]) / MUSICNET_SR,
                "note": int(row["note"]),
                "start_beat": float(row["start_beat"]),
            })
    rows.sort(key=lambda r: r["onset_sec"])
    return rows


def _real_instrument_for_piece(piece_id: str, data_dir: Path) -> str:
    """
    Real per-piece instrument, looked up the same way
    run_task3_benchmark.py's real-data run does: MusicNet's own
    musicnet_metadata.csv "ensemble" column, mapped through
    INSTRUMENT_MAP (both from validate_alignment_against_musicnet.py) --
    not reinvented here, reused.
    """
    rows = {r["id"]: r for r in load_rows(data_dir / "musicnet_metadata.csv")}
    return rows[piece_id]["instrument"]


def run_free_legs(piece_id: str, data_dir: Path, mistake_type: str, rng_seed: int) -> dict:
    """
    One benchmark case, free legs only. Loads piece_id's real MusicNet
    score+audio+labels, injects one mistake, runs the real run_pitch_
    tracking + dtw_align_to_score against the INJECTED audio, and checks
    whether DTW localized the injected note to the same measure the
    injection's own onset_sec falls in (ground truth derived the same way
    validate_alignment_against_musicnet already does, via start_beat and
    beats_per_measure_from_time_sig -- reused, not reimplemented).

    Returns {"piece_id", "mistake_type", "injected", "detected_at_measure",
    "true_measure", "localization_correct", "cost_dollars": 0.0} --
    cost_dollars is always 0.0 here; Task 4's paid-leg function adds the
    real Gemini/Claude cost on top once that's separately approved.
    """
    score = midi_score_to_dict(data_dir / "midis" / f"{piece_id}.mid")
    ground_truth = load_ground_truth_with_end_sec(data_dir / "labels" / f"{piece_id}.csv")
    wav_bytes = (data_dir / "audio" / f"{piece_id}.wav").read_bytes()
    instrument = _real_instrument_for_piece(piece_id, data_dir)

    result = inject_mistake(wav_bytes, ground_truth, mistake_type, rng_seed)
    injected = result["injected"]

    time_sig = score.get("time_signature") or "4/4"
    beats_per_measure = w.beats_per_measure_from_time_sig(time_sig)

    # Same formula validate_alignment_against_musicnet.py uses for ground
    # truth: find the label row nearest the injection's own onset time,
    # convert its start_beat to a measure number.
    nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - injected["onset_sec"]))
    true_measure = int(nearest["start_beat"] // beats_per_measure) + 1

    events = w.run_pitch_tracking(result["wav_bytes"], instrument=instrument)
    aligned = w.dtw_align_to_score(events, score, start_measure=1,
                                    beats_per_measure=beats_per_measure)

    detected_at_measure = None
    for ev in aligned:
        if abs(ev["time_sec"] - injected["onset_sec"]) < 0.3:
            detected_at_measure = ev.get("measure")
            break

    return {
        "piece_id": piece_id, "mistake_type": mistake_type, "injected": injected,
        "detected_at_measure": detected_at_measure, "true_measure": true_measure,
        "localization_correct": detected_at_measure == true_measure,
        "cost_dollars": 0.0,
    }
