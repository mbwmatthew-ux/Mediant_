import numpy as np
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from inject_audio_mistakes import inject_mistake, SR


def _sine_wav(freq_hz: float, duration_sec: float) -> np.ndarray:
    t = np.linspace(0, duration_sec, int(SR * duration_sec), endpoint=False)
    return 0.5 * np.sin(2 * np.pi * freq_hz * t)


def _wav_bytes(samples: np.ndarray) -> bytes:
    import soundfile as sf
    import io
    buf = io.BytesIO()
    sf.write(buf, samples, SR, format="WAV")
    return buf.getvalue()


def test_wrong_pitch_shifts_only_the_target_note():
    # A4 (MIDI 69, 440Hz) held for 3 seconds, silence before/after.
    samples = np.concatenate([np.zeros(SR), _sine_wav(440.0, 3.0), np.zeros(SR)])
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 1.0, "end_sec": 4.0, "note": 69, "start_beat": 1.0}]

    result = inject_mistake(wav_bytes, ground_truth, "wrong_pitch", rng_seed=0)

    assert result["injected"]["mistake_type"] == "wrong_pitch"
    assert result["injected"]["original_note"] == 69
    assert result["injected"]["new_note"] != 69
    assert result["injected"]["onset_sec"] == 1.0
    assert result["injected"]["offset_sec"] == 4.0
    assert isinstance(result["wav_bytes"], bytes) and len(result["wav_bytes"]) > 0


def test_deleted_note_silences_the_target_window():
    samples = np.concatenate([np.zeros(SR), _sine_wav(440.0, 2.0), np.zeros(SR)])
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 1.0, "end_sec": 3.0, "note": 69, "start_beat": 1.0}]

    result = inject_mistake(wav_bytes, ground_truth, "deleted_note", rng_seed=0)

    import soundfile as sf
    import io
    out, sr = sf.read(io.BytesIO(result["wav_bytes"]))
    window = out[int(1.0 * sr):int(3.0 * sr)]
    # The core of the window (excluding the short crossfade margins at each
    # edge -- see CROSSFADE_SEC) must be near-silent. The margins themselves
    # deliberately taper from/to real audio now, so they're excluded here
    # rather than requiring the WHOLE window to be near digital zero.
    margin = int(0.01 * sr) + 10  # CROSSFADE_SEC's sample count, plus slack
    core = window[margin:-margin]
    assert np.sqrt(np.mean(core ** 2)) < 0.01  # near-silent in the core, away from the fade edges
    assert result["injected"] == {
        "mistake_type": "deleted_note", "onset_sec": 1.0, "offset_sec": 3.0,
        "original_note": 69, "new_note": None,
    }


def test_duplicated_note_repeats_the_target_window():
    samples = np.concatenate([np.zeros(SR), _sine_wav(440.0, 1.0), np.zeros(SR * 2)])
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 1.0, "end_sec": 2.0, "note": 69, "start_beat": 1.0}]

    result = inject_mistake(wav_bytes, ground_truth, "duplicated_note", rng_seed=0)

    import soundfile as sf
    import io
    out, sr = sf.read(io.BytesIO(result["wav_bytes"]))
    # Duplicating a 1s note inserts 1s of extra audio -- total length grows.
    assert len(out) / sr > len(samples) / SR
    assert result["injected"]["mistake_type"] == "duplicated_note"
    assert result["injected"]["new_note"] == 69  # same pitch, extra occurrence


def test_unknown_mistake_type_raises():
    import pytest
    samples = _sine_wav(440.0, 1.0)
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 0.0, "end_sec": 1.0, "note": 69, "start_beat": 1.0}]
    with pytest.raises(ValueError, match="mistake_type"):
        inject_mistake(wav_bytes, ground_truth, "not_a_real_type", rng_seed=0)


def test_duplicated_note_injected_timing_refers_to_pre_shift_window():
    # Requirement: onset_sec/offset_sec in the returned `injected` dict must
    # describe the ORIGINAL note's own window on the pre-shift time axis,
    # never adjusted for the fact that duplication shifts everything after
    # it later in time. The note sits at [1.0, 2.0) in the ORIGINAL audio;
    # the injected dict must keep saying [1.0, 2.0), not some shifted value,
    # even though the duplicate copy now occupies [2.0, 3.0) in the output.
    samples = np.concatenate([np.zeros(SR), _sine_wav(440.0, 1.0), np.zeros(SR * 2)])
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 1.0, "end_sec": 2.0, "note": 69, "start_beat": 1.0}]

    result = inject_mistake(wav_bytes, ground_truth, "duplicated_note", rng_seed=0)

    assert result["injected"]["onset_sec"] == 1.0
    assert result["injected"]["offset_sec"] == 2.0


def test_inject_mistake_does_not_mutate_caller_inputs():
    # Requirement: a "control" recording for the benchmark is simply the
    # original wav_bytes reused untouched -- inject_mistake must never
    # mutate the caller's wav_bytes object or the ground_truth_notes list
    # (or the dicts inside it) in place, for ANY mistake_type, including
    # the in-place-looking "deleted_note" (zeroes a numpy array) and
    # "wrong_pitch" (assigns back into a numpy array) paths.
    samples = np.concatenate([np.zeros(SR), _sine_wav(440.0, 2.0), np.zeros(SR)])
    original_wav_bytes = _wav_bytes(samples)
    wav_bytes_copy = bytes(original_wav_bytes)  # independent copy to compare against
    ground_truth = [{"onset_sec": 1.0, "end_sec": 3.0, "note": 69, "start_beat": 1.0}]
    ground_truth_snapshot = [dict(d) for d in ground_truth]

    for mistake_type in ("wrong_pitch", "deleted_note", "duplicated_note"):
        inject_mistake(original_wav_bytes, ground_truth, mistake_type, rng_seed=0)
        assert original_wav_bytes == wav_bytes_copy, (
            f"wav_bytes was mutated by mistake_type={mistake_type!r}"
        )
        assert ground_truth == ground_truth_snapshot, (
            f"ground_truth_notes was mutated by mistake_type={mistake_type!r}"
        )
