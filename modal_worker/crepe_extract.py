"""
"MEDIANT — Basic Pitch note-extraction feasibility" (2026-11-04).

Stage 2 of 3: extract CREPE note events for the same 8 real MusicNet dev
pieces, via `worker.run_pitch_tracking` UNMODIFIED, in the main
validation venv (torch/torchcrepe). Kept separate from Stage 1
(`basic_pitch_extract.py`, its own venv) to avoid any dependency
conflict between the two tools being compared.

Output: JSON per piece, {piece_id: {"events": [{"time_sec", "midi"}, ...],
"elapsed_sec": float}}.

No production code touched. `worker.py` imported and called, never
modified. Isolated validation venv only, $0 cost (CPU-only).
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import worker as w
from validate_alignment_against_musicnet import load_rows

DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]
OUT = Path(__file__).parent / "crepe_events.json"


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    results = {}
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        wav_bytes = (DATA / "audio" / f"{pid}.wav").read_bytes()
        t0 = time.time()
        raw_events = w.run_pitch_tracking(wav_bytes, instrument=instrument)
        elapsed = time.time() - t0
        events = [{"time_sec": float(e["time_sec"]), "end_sec": float(e["end_sec"]), "midi": int(e["midi_raw"])}
                   for e in raw_events]
        results[pid] = {"instrument": instrument, "events": events, "elapsed_sec": elapsed}
        print(f"{pid} ({instrument}): {len(events)} note events in {elapsed:.1f}s")

    OUT.write_text(json.dumps(results, indent=2))
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
