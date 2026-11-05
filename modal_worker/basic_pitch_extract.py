"""
"MEDIANT — Basic Pitch note-extraction feasibility" (2026-11-04).

Stage 1 of 3: extract Basic Pitch (Spotify, Apache-2.0, pip-installable)
note events for the 8 real MusicNet dev pieces. Run in its own isolated
venv (`venv_basic_pitch`, Python 3.11 -- the main validation venv is
Python 3.13, and basic-pitch's `tensorflow-macos<2.15.1` constraint has
no wheel for 3.13; on this Mac + Python 3.11 combination basic-pitch
uses its CoreML backend instead, so no TensorFlow install was actually
needed). Separate venv, separate stage, so this never touches the
`torch`/`torchcrepe` stack `worker.py`'s `run_pitch_tracking` needs
(stage 2, run separately) -- avoids any cross-library dependency
conflict between the two tools being compared.

Output: JSON per piece, {piece_id: [{"time_sec": onset, "midi": pitch}, ...]},
written to this file's own output path. Stage 3
(`basic_pitch_vs_crepe_report.py`) loads both stages' JSON and does the
actual comparison via the existing, unmodified `note_sequence_evaluator.py`.

No production code touched. Isolated venv only, $0 cost (CPU-only
CoreML inference, confirmed no network/API calls).
"""
import json
import time
from pathlib import Path

from basic_pitch.inference import predict

DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]
OUT = Path(__file__).parent / "basic_pitch_events.json"


def main():
    results = {}
    for pid in DEV_PIECES:
        wav = DATA / "audio" / f"{pid}.wav"
        t0 = time.time()
        _, _, note_events = predict(str(wav))
        elapsed = time.time() - t0
        events = [{"time_sec": float(start), "end_sec": float(end), "midi": int(round(pitch)),
                    "amplitude": float(amp)}
                   for start, end, pitch, amp, bend in note_events]
        results[pid] = {"events": events, "elapsed_sec": elapsed}
        print(f"{pid}: {len(events)} note events in {elapsed:.1f}s")

    OUT.write_text(json.dumps(results, indent=2))
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
