"""
New owner directive (2026-11-04), Task 1: audit existing evidence before
building anything new. Task 2 of the prior sprint found only 2/8 dev
pieces produced a verified `wrong_pitch` injection within 8 attempts each
-- too small (n=2) to trust a recall/precision number on. This script
asks the smallest possible question: does trying MORE attempts with the
SAME unmodified `inject_mistake_verified` gate, on the SAME 8-piece dev
set, fix that -- before building any new dataset/pipeline.

No new infrastructure: reuses `inject_mistake_verified` (already
repaired, unmodified here) exactly as Task 2 called it, just with more
distinct `base_seed` values per piece so more of the piece's notes get
tried as injection targets. Real measured per-attempt cost (this script
also answers Task 3's latency question for the injection-verification
step specifically): ~10s/attempt (dominated by `run_pitch_tracking`,
measured directly before this run), so a bounded budget (4 extra
batches of 8 = 32 new attempts per piece, stopping early at 3 total
valid cases found) costs at most ~5.3 CPU-minutes per piece -- cheap
enough to just run, no new harness needed.

No production code touched. `worker.py` unaffected.

RESULTS (measured 2026-11-04): +4 new valid cases found in 32 additional
attempts/piece (2288: +1, 2293: +2, 2295: +1); 0 new on 2202/2203/2217/2221
despite the same 32 extra attempts each (40 total attempts/piece,
0 successes — a strong null result, not sparse-sample bad luck).
**Coverage: 2/8 pieces -> 4/8 pieces; 2 valid cases -> 6 valid cases.**

Real, instrument-correlated pattern, not investigated further (out of
scope for "smallest additional ground truth" per the directive): BOTH
Flute pieces (2202, 2203) never produce a single valid injection even
at 5x the original attempt budget; 2 of 5 Cello pieces (2217, 2221)
never do either, while the other 3 Cello pieces and the 1 Violin piece
all succeed easily. The "not acoustically recognizable" failure mode
this gate catches looks piece/instrument-dependent and systematic on
these 4 pieces specifically, not a matter of trying more random seeds.

**Conclusion: a bounded 4x attempt increase, with ZERO new
infrastructure, improved coverage 3x (2->6 cases) and piece-coverage 2x
(2/8->4/8) — real progress, cheap, exactly what the directive asked
for — but did NOT fully solve the n-problem.** Flute coverage remains
at zero regardless of attempt count; a genuinely larger n for Flute
specifically would need either a different mistake type (not
`wrong_pitch`) or fixing the injection methodology itself, both out of
scope for this bounded check. Stopped here, as instructed — not
escalating into a new injection-methodology project without separate
authorization.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import worker as w
from benchmark_full_pipeline import load_ground_truth_with_end_sec
from validate_alignment_against_musicnet import load_rows
from inject_audio_mistakes import inject_mistake_verified
from score_conditioned_verification_prototype import DEV_PIECES, DATA, SCORES

MAX_EXTRA_BATCHES = 4   # 4 * 8 = 32 new attempts per piece, on top of Task 2's original 8
TARGET_VALID = 3        # stop early once a piece has this many valid cases total


def main():
    meta_rows = {r["id"]: r for r in load_rows(DATA / "musicnet_metadata.csv")}
    results = {}

    for pid in DEV_PIECES:
        instrument = meta_rows[pid]["instrument"]
        musicxml = SCORES / f"{pid}.musicxml"
        label = DATA / "labels" / f"{pid}.csv"
        score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
        beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])
        ground_truth = load_ground_truth_with_end_sec(label)
        wav_bytes_orig = (DATA / "audio" / f"{pid}.wav").read_bytes()

        valid_cases = []
        total_new_attempts = 0
        for batch in range(1, MAX_EXTRA_BATCHES + 1):
            base_seed = int(pid) * 10 + batch   # distinct from Task 2's base_seed=int(pid)
            inj = inject_mistake_verified(wav_bytes_orig, ground_truth, score_dict,
                                           beats_per_measure, instrument, base_seed=base_seed,
                                           max_attempts=8)
            total_new_attempts += len(inj["attempts"])
            if inj["valid"]:
                valid_cases.append(inj["result"]["injected"])
            if len(valid_cases) >= TARGET_VALID:
                break

        results[pid] = {"instrument": instrument, "new_valid": len(valid_cases),
                         "new_attempts": total_new_attempts,
                         "cases": valid_cases}
        print(f"{pid} ({instrument}): {len(valid_cases)} NEW valid case(s) found in "
              f"{total_new_attempts} additional attempts")

    print("\n=== Summary ===")
    original_valid = {"2202": 0, "2203": 0, "2217": 0, "2221": 0,
                       "2288": 1, "2293": 0, "2294": 1, "2295": 0}
    total_old = sum(original_valid.values())
    total_new = sum(r["new_valid"] for r in results.values())
    pieces_with_any = sum(1 for pid in DEV_PIECES
                          if original_valid[pid] > 0 or results[pid]["new_valid"] > 0)
    print(f"Original (Task 2, 8 attempts/piece): {total_old} valid cases, "
          f"2/8 pieces produced any")
    print(f"After {MAX_EXTRA_BATCHES * 8} additional attempts/piece: "
          f"+{total_new} new valid cases, {pieces_with_any}/8 pieces now have >=1")
    print(f"Total valid cases available for Task 2/3 recall/precision measurement: "
          f"{total_old + total_new}")


if __name__ == "__main__":
    main()
