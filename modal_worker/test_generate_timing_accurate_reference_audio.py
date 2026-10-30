import io

import pytest
import soundfile as sf

from generate_timing_accurate_reference_audio import (
    render_timing_accurate_reference_audio,
    SAMPLE_RATE,
)


def test_renders_expected_duration_and_sample_rate():
    notes = [
        {"onset_sec": 0.0, "note": 69, "end_sec": 0.5},
        {"onset_sec": 0.6, "note": 72, "end_sec": 1.2},
    ]
    wav_bytes = render_timing_accurate_reference_audio(notes, "Violin")
    audio, sr = sf.read(io.BytesIO(wav_bytes))
    assert sr == SAMPLE_RATE == 16000
    # fluidsynth pads a short release tail past the last note's end_sec;
    # duration should be at least that long, not shorter.
    assert len(audio) / sr >= 1.2


def test_overlapping_notes_both_render_not_deduplicated():
    # A genuine chord: two notes with identical onset/offset.
    notes = [
        {"onset_sec": 0.0, "note": 60, "end_sec": 1.0},
        {"onset_sec": 0.0, "note": 64, "end_sec": 1.0},
    ]
    wav_bytes = render_timing_accurate_reference_audio(notes, "Violin")
    audio, sr = sf.read(io.BytesIO(wav_bytes))
    # Two simultaneous notes should produce real signal, not silence or
    # a single-note-only render (a crude proxy: non-trivial RMS energy).
    assert audio.ndim >= 1
    import numpy as np
    assert np.sqrt(np.mean(audio[:int(0.5 * sr)].astype(float) ** 2)) > 1e-4


def test_no_transposition_applied_pitch_matches_label_exactly():
    # Render A440 (MIDI 69) and confirm the synthesized fundamental lands
    # at 440Hz, not shifted by any transposing-instrument interval.
    import numpy as np
    notes = [{"onset_sec": 0.0, "note": 69, "end_sec": 1.0}]
    wav_bytes = render_timing_accurate_reference_audio(notes, "Violin")
    audio, sr = sf.read(io.BytesIO(wav_bytes))
    # Use the sustained middle of the note to avoid the attack transient.
    segment = audio[int(0.2 * sr):int(0.8 * sr)].astype(float)
    spectrum = np.abs(np.fft.rfft(segment))
    freqs = np.fft.rfftfreq(len(segment), d=1.0 / sr)
    peak_freq = freqs[np.argmax(spectrum)]
    assert abs(peak_freq - 440.0) < 10.0, f"expected ~440Hz, got {peak_freq:.1f}Hz"


def test_empty_notes_does_not_crash():
    wav_bytes = render_timing_accurate_reference_audio([], "Flute")
    audio, sr = sf.read(io.BytesIO(wav_bytes))
    assert sr == SAMPLE_RATE


def test_zero_duration_note_is_skipped_not_crashed():
    notes = [
        {"onset_sec": 1.0, "note": 60, "end_sec": 1.0},  # zero duration
        {"onset_sec": 1.1, "note": 62, "end_sec": 1.5},
    ]
    wav_bytes = render_timing_accurate_reference_audio(notes, "Cello")
    audio, sr = sf.read(io.BytesIO(wav_bytes))
    assert len(audio) / sr >= 1.5
