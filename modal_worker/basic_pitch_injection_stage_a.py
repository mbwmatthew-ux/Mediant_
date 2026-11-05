"""
"MEDIANT — Basic Pitch note-extraction feasibility" (2026-11-04), step 8,
stage A of 3.

Reconstructs the 6 verified `wrong_pitch` injections found this round
(2 original from the 2026-11-01 run + 4 new from today's
`task1_expand_injection_coverage.py` expansion) -- same deterministic
seeds, same unmodified `inject_mistake_verified` gate, nothing rebuilt.
Writes each injected take's WAV to disk plus its metadata, so Stage B
(run in the OTHER venv, for Basic Pitch) can read the file without
needing torch/torchcrepe in that environment.

No production code touched.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import worker as w
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from validate_alignment_against_musicnet import load_rows
from inject_audio_mistakes import inject_mistake_verified

DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")
OUT_DIR = Path(__file__).parent / "injected_cases"
OUT_DIR.mkdir(exist_ok=True)

DEV_PIECES = ["2202", "2203", "2217", "2221", "2288", "2293", "2294", "2295"]


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    manifest = []
    case_num = 0
    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        label = DATA / "labels" / f"{pid}.csv"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        bpm = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        ground_truth = load_ground_truth_with_end_sec(label)
        wav_bytes_orig = (DATA / "audio" / f"{pid}.wav").read_bytes()

        found_this_piece = []
        # Original seed scheme (2026-11-01): base_seed = int(pid)
        inj = inject_mistake_verified(wav_bytes_orig, ground_truth, score_dict, bpm,
                                       instrument, base_seed=int(pid), max_attempts=8)
        if inj["valid"]:
            found_this_piece.append(inj["result"])
        # Expanded seed scheme (2026-11-04): base_seed = int(pid)*10 + batch
        for batch in range(1, 5):
            base_seed = int(pid) * 10 + batch
            inj = inject_mistake_verified(wav_bytes_orig, ground_truth, score_dict, bpm,
                                           instrument, base_seed=base_seed, max_attempts=8)
            if inj["valid"]:
                found_this_piece.append(inj["result"])
            if len(found_this_piece) >= 3:
                break

        for result in found_this_piece:
            case_num += 1
            injected = result["injected"]
            wav_path = OUT_DIR / f"case_{case_num:02d}_{pid}.wav"
            wav_path.write_bytes(result["wav_bytes"])
            manifest.append({"case": case_num, "piece": pid, "instrument": instrument,
                              "wav_path": str(wav_path), "original_note": injected["original_note"],
                              "new_note": injected["new_note"], "measure": injected["measure"],
                              "onset_sec": injected["onset_sec"], "offset_sec": injected["offset_sec"]})
            print(f"case {case_num}: piece {pid} measure {injected['measure']} "
                  f"{injected['original_note']}->{injected['new_note']} -> {wav_path.name}")

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} verified cases written to {OUT_DIR}")


if __name__ == "__main__":
    main()
