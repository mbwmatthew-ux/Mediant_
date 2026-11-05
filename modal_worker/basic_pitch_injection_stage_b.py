"""
"MEDIANT — Basic Pitch note-extraction feasibility" (2026-11-04), step 8,
stage B of 3. Runs in `venv_basic_pitch`.

Extracts Basic Pitch note events from each of the 6 verified injected
WAVs written by Stage A (`injected_cases/manifest.json`). Output feeds
Stage C's symbolic alignment + wrong-note detection check.

No production code touched. $0 cost, CPU-only.
"""
import json
from pathlib import Path

from basic_pitch.inference import predict

HERE = Path(__file__).parent
MANIFEST = json.loads((HERE / "injected_cases" / "manifest.json").read_text())
OUT = HERE / "injected_cases" / "basic_pitch_events.json"


def main():
    results = {}
    for case in MANIFEST:
        _, _, note_events = predict(case["wav_path"])
        events = [{"time_sec": float(start), "end_sec": float(end), "midi": int(round(pitch))}
                   for start, end, pitch, amp, bend in note_events]
        results[str(case["case"])] = events
        print(f"case {case['case']} ({case['piece']}): {len(events)} note events")

    OUT.write_text(json.dumps(results, indent=2))
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
