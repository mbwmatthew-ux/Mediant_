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
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
from validate_alignment_against_musicnet import (  # noqa: E402
    midi_score_to_dict, load_ground_truth)
from inject_audio_mistakes import inject_mistake  # noqa: E402


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
    ground_truth = load_ground_truth(data_dir / "labels" / f"{piece_id}.csv")
    wav_bytes = (data_dir / "audio" / f"{piece_id}.wav").read_bytes()

    result = inject_mistake(wav_bytes, ground_truth, mistake_type, rng_seed)
    injected = result["injected"]

    time_sig = score.get("time_signature") or "4/4"
    beats_per_measure = w.beats_per_measure_from_time_sig(time_sig)

    # Same formula validate_alignment_against_musicnet.py uses for ground
    # truth: find the label row nearest the injection's own onset time,
    # convert its start_beat to a measure number.
    nearest = min(ground_truth, key=lambda r: abs(r["onset_sec"] - injected["onset_sec"]))
    true_measure = int(nearest["start_beat"] // beats_per_measure) + 1

    events = w.run_pitch_tracking(result["wav_bytes"], instrument="Violin")
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
