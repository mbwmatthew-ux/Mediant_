"""
Extracts Basic Pitch note events for the project's frozen 6-piece
held-out set (2204/Flute, 2218/Cello, 2222/Cello, 2297/Cello,
2244/Violin, 2289/Violin) -- never touched for any recall/FP tuning
decision this project has made. Written to its OWN output file,
separate from basic_pitch_events.json (the 8 dev pieces), so the two
caches can never be confused about which is dev vs. held-out.

Same isolated venv_basic_pitch (Python 3.11, CoreML backend) as
basic_pitch_extract.py. $0, CPU-only.
"""
import json
import time
from pathlib import Path

from basic_pitch.inference import predict

DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
FROZEN_PIECES = ["2204", "2218", "2222", "2297", "2244", "2289"]
OUT = Path(__file__).parent / "basic_pitch_events_frozen6.json"


def main():
    results = {}
    for pid in FROZEN_PIECES:
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
