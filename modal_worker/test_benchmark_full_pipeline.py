import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from benchmark_full_pipeline import run_free_legs


def test_run_free_legs_reports_localization_against_injected_ground_truth():
    fake_score = {"measures": [{"number": 1, "notes": []}, {"number": 2, "notes": []}]}
    # Real-shaped ground-truth rows: load_ground_truth_with_end_sec (the
    # real loader run_free_legs now calls) always includes "end_sec" --
    # unlike the old load_ground_truth, whose rows lack it and would
    # KeyError inside inject_mistake on real data. Keeping end_sec here
    # is deliberate: it's what the real loader actually returns, not a
    # convenience the mock adds on top of it.
    fake_ground_truth = [
        {"onset_sec": 1.0, "end_sec": 2.0, "note": 69, "start_beat": 1.0},
        {"onset_sec": 3.0, "end_sec": 4.0, "note": 72, "start_beat": 1.0},
    ]
    fake_injection = {
        "wav_bytes": b"fake-wav-bytes",
        "injected": {"mistake_type": "wrong_pitch", "onset_sec": 1.0,
                     "offset_sec": 2.0, "original_note": 69, "new_note": 74},
    }
    fake_events = [{"pitches": ["D5"], "time_sec": 1.1}]
    fake_aligned = [{"pitches": ["D5"], "time_sec": 1.1, "measure": 1}]

    # Piece "2186" is mapped to "Cello" here deliberately (not the real
    # instrument for 2186, and not "Violin" either) -- if run_free_legs
    # ever regresses back to hardcoding "Violin", this test must fail by
    # asserting run_pitch_tracking was called with the looked-up value,
    # not by coincidentally matching a hardcoded default.
    with patch("benchmark_full_pipeline.midi_score_to_dict", return_value=fake_score), \
         patch("benchmark_full_pipeline.load_ground_truth_with_end_sec", return_value=fake_ground_truth), \
         patch("benchmark_full_pipeline._real_instrument_for_piece", return_value="Cello"), \
         patch("benchmark_full_pipeline.inject_mistake", return_value=fake_injection), \
         patch("pathlib.Path.read_bytes", return_value=b"fake-wav-bytes"), \
         patch("benchmark_full_pipeline.w.run_pitch_tracking", return_value=fake_events) as mock_pitch_tracking, \
         patch("benchmark_full_pipeline.w.dtw_align_to_score", return_value=fake_aligned), \
         patch("benchmark_full_pipeline.w.beats_per_measure_from_time_sig", return_value=4):
        result = run_free_legs("2186", Path("/fake/data"), "wrong_pitch", rng_seed=0)

    assert result["piece_id"] == "2186"
    assert result["mistake_type"] == "wrong_pitch"
    assert result["true_measure"] == 1   # onset_sec=1.0 falls in the injected note's own measure
    assert result["detected_at_measure"] == 1
    assert result["localization_correct"] is True
    assert result["cost_dollars"] == 0.0
    # The real per-piece instrument (looked up via _real_instrument_for_
    # piece, mocked to "Cello" above) must reach run_pitch_tracking --
    # this is the exact bug class the hardcoded "Violin" default was.
    mock_pitch_tracking.assert_called_once_with(b"fake-wav-bytes", instrument="Cello")
