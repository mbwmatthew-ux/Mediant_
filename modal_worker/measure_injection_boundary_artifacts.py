"""
Reproduces the splice-boundary measurements cited in
inject_audio_mistakes.py's module docstring ("Known artifacts that make
injected mistakes acoustically unrealistic").

Not a test, not part of the production path, not run in CI -- a small
deterministic documentation aid. It builds a synthetic fixture (three
concatenated tones at different frequencies/phases, chosen so none of
the three mistake types' boundaries coincidentally lands on a
zero-crossing -- the one thing that would understate the artifact),
runs each mistake_type through the real inject_mistake with a fixed
rng_seed, and prints the sample-to-sample jump at each splice boundary
against the fixture's own typical in-tone sample-to-sample delta.

Run: `source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
&& cd modal_worker && python3 measure_injection_boundary_artifacts.py`
"""
import io
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parent))
from inject_audio_mistakes import SR, inject_mistake


def _sine_wav(freq_hz: float, duration_sec: float, phase: float = 0.0) -> np.ndarray:
    t = np.linspace(0, duration_sec, int(SR * duration_sec), endpoint=False)
    return 0.5 * np.sin(2 * np.pi * freq_hz * t + phase)


def _wav_bytes(samples: np.ndarray) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, SR, format="WAV")
    return buf.getvalue()


def main() -> None:
    pre = _sine_wav(293.0, 1.0, phase=0.3)
    note = _sine_wav(440.63, 2.0, phase=0.9)
    post = _sine_wav(293.0, 1.0, phase=1.7)
    samples = np.concatenate([pre, note, post])
    wav_bytes = _wav_bytes(samples)
    ground_truth = [{"onset_sec": 1.0, "end_sec": 3.0, "note": 69, "start_beat": 1.0}]

    typical = float(np.abs(np.diff(samples[int(1.5 * SR):int(1.5 * SR) + 2000])).mean())
    print(f"typical_natural_delta = {typical:.6f}")

    for mistake_type in ("wrong_pitch", "deleted_note", "duplicated_note"):
        result = inject_mistake(wav_bytes, ground_truth, mistake_type, rng_seed=0)
        out, sr = sf.read(io.BytesIO(result["wav_bytes"]))
        onset_idx, offset_idx = int(1.0 * sr), int(3.0 * sr)
        onset_jump = float(abs(out[onset_idx] - out[onset_idx - 1]))
        if mistake_type == "duplicated_note":
            splice_jump = float(abs(out[offset_idx] - out[offset_idx - 1]))
            print(
                f"{mistake_type}: onset_jump={onset_jump:.4f} "
                f"({onset_jump / typical:.1f}x), "
                f"splice_jump={splice_jump:.4f} ({splice_jump / typical:.1f}x)"
            )
        else:
            offset_jump = float(abs(out[offset_idx] - out[offset_idx - 1]))
            print(
                f"{mistake_type}: onset_jump={onset_jump:.4f} "
                f"({onset_jump / typical:.1f}x), "
                f"offset_jump={offset_jump:.4f} ({offset_jump / typical:.1f}x)"
            )


if __name__ == "__main__":
    main()
