"""
"MEDIANT — Score-Conditioned Audio Verification Feasibility" sprint, Task 1.

Tests Parangonar (https://github.com/sildater/parangonar, PyPI `parangonar`)
as a third audio-to-score alignment candidate, alongside the production
pipeline's discrete-pitch-event DTW and the chroma/CQT continuous-feature
experiment (`chroma_alignment_experiment.py`, NO-GO'd in the prior sprint).

Package verification (done for real, not assumed):
  - Installed via `pip install parangonar` into the isolated validation venv
    only (`/Users/matthewwu/.cache/mediant_validation/venv`) — NOT a
    production dependency; `worker.py`'s Modal image is untouched.
  - Version 3.4.1 as installed. License: Apache-2.0 (confirmed against the
    installed package's own LICENSE file, matching GitHub). Maintained by
    Silvan Peter / CPJKU (also maintains Partitura, this package's main
    dependency — a legitimate, well-known MIR research group).
  - `AudioToScoreMatcher` (used here) is "audio-to-score alignment via
    elastic DP with full candidate evaluation": builds an 88-bin IIR
    log-frequency spectrogram (one bin per piano key, full pitch resolution
    — NOT chroma-folded, unlike the prior sprint's experiment) and runs a
    beat-period-adaptive elastic DTW against the score's note array.

Score representation: real MusicXML (`visual_corpus/clean/{id}.musicxml`,
the same files used by the page-omr/deskew validation rounds) loaded via
`partitura.load_musicxml(...).note_array()` — a direct, native integration,
no format conversion from this project's internal dict shape was needed.
`beats_per_measure` for measure classification still comes from this
project's own `parse_musicxml`/`beats_per_measure_from_time_sig`, to keep
measure-numbering convention identical across all three candidates.

Scoring: each score note gets a predicted `performance_time` from
Parangonar. `nearest_ground_truth_measure` and `classify_alignment` — the
SAME functions `validate_alignment_against_musicnet.py` already uses for
the production baseline — convert that into a measure classification
(correct/off_by_one/wrong/unmatched) against MusicNet's real ground truth,
for direct, apples-to-apples comparability with the other two candidates.

RESULTS (measured 2026-11-01, real MusicNet audio+score, 13 pieces: the 9
prior-sprint dev pieces + the 4 directive-named failure cases):

    piece  instr   current(DTW)  chroma-DTW  parangonar
    2202   -       (not individually baselined earlier)   95.9%
    2203   -       (not individually baselined earlier)   94.6%
    2217   -       (not individually baselined earlier)   97.0%
    2221   -       (not individually baselined earlier)   95.9%
    2241   -       (not individually baselined earlier)    1.6%  <- NEW failure, not seen in either prior candidate
    2288   -       (not individually baselined earlier)   99.2%
    2293   Cello    82.5%         88.7%                    94.6%
    2294   -       (not individually baselined earlier)   95.9%
    2295   Cello    83.2%         85.3%                    95.9%
    2220   Cello     0.4%         66.8%                     2.0%  <- still catastrophic, worse than chroma
    2242   Violin   49.8%         78.3%                    92.7%
    2296   Cello     2.0%         80.1%                    54.6%  <- better than current, worse than chroma
    2244   Violin   89.6%         47.1% (chroma REGRESSED)  96.4%  <- parangonar fixes exactly what broke chroma

10 of 13 pieces: 92.7-99.2% correct — a large, consistent improvement over
BOTH prior candidates on every piece they could be compared on except
2220/2296 (where parangonar beats current-pipeline but not chroma-DTW).
Critically, 2244 — the piece where chroma-DTW regressed severely
(89.6%->47.1%) — is NOT a weak point for parangonar (96.4%): its failure
mode is independent of the discrete-event-DTW defect AND the chroma
template's fixed-tempo-resolution defect.

Two real, uninvestigated failures remain: 2220 (2.0%, "wrong" dominates —
187/196 notes, not "unmatched" — consistent with a global desync rather
than local difficulty) and 2241 (1.6%, 314/498 "wrong") — a NEW failure
mode not seen in either prior candidate (2241 was one of the 9 pieces that
reached 90-100% under the prior sprint's perfect-ground-truth-input
diagnostic, so this is not the same already-known defect). Root cause not
traced here — plausible mechanism (not confirmed): MusicNet's real
performance omitting/adding a repeat the elastic-DP's bounded stretch
cannot recover from, causing a global rather than local misalignment.
2296 (54.6%) sits between current and chroma — not chased further either.

HELD-OUT INTEGRITY — a real constraint found this task, reported honestly
rather than worked around: the directive asked for a NEW frozen subset,
separate from the 6 pieces (2204/2218/2222/2297/2244/2289) already opened
in the prior sprint's Task 3/4. **No such subset can be honestly
constructed from this project's existing data.** Checked directly against
MusicNet's own metadata: this project has already downloaded and used
EVERY monophonic solo Violin/Cello/Flute piece in the entire MusicNet
corpus (24/24 — the 18 held-out + 4 excluded-by-sanity-check + 2
designated dev/tuning pieces, `2186`/`2219`, already used throughout this
project's history). The only unused MusicNet pieces are 156 Solo Piano
recordings — a different, polyphonic instrument class, not a drop-in
substitute, and out of scope to introduce here without separate
authorization. Getting a genuinely fresh monophonic frozen set requires
downloading additional real MusicNet audio beyond what's cached locally
(free, same public dataset — just more of it) — not done this round.

No production code touched. `worker.py` unaffected.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import soundfile as sf
import partitura as pt
import parangonar as pa

import worker as w
from validate_alignment_against_musicnet import (
    load_ground_truth, classify_alignment, nearest_ground_truth_measure,
)

DATA = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORES = Path("/Users/matthewwu/.cache/mediant_validation/visual_corpus/clean")

PIECES = ["2202", "2203", "2217", "2221", "2241", "2288", "2293", "2294", "2295",
          "2220", "2242", "2296", "2244"]


def run_piece(matcher, pid: str) -> dict | None:
    musicxml = SCORES / f"{pid}.musicxml"
    wav = DATA / "audio" / f"{pid}.wav"
    label = DATA / "labels" / f"{pid}.csv"
    if not (musicxml.exists() and wav.exists() and label.exists()):
        return None

    t0 = time.time()
    audio, sr = sf.read(str(wav))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    score_dict = w.parse_musicxml(musicxml.read_bytes(), 1)
    beats_per_measure = w.beats_per_measure_from_time_sig(score_dict["time_signature"])

    score = pt.load_musicxml(str(musicxml))
    na = score.note_array()
    ground_truth = load_ground_truth(label)

    alignment = matcher(audio.astype(np.float32), na, sample_rate=sr)
    elapsed = time.time() - t0

    counts = {"correct": 0, "off_by_one": 0, "wrong": 0, "unmatched": 0}
    for i, entry in enumerate(alignment):
        onset_beat = float(na[i]["onset_beat"])
        true_measure = int(onset_beat // beats_per_measure) + 1
        pred_time = entry.get("performance_time")
        predicted_measure = (
            nearest_ground_truth_measure(pred_time, ground_truth, beats_per_measure)
            if pred_time is not None else None
        )
        counts[classify_alignment(predicted_measure, true_measure)] += 1

    n = sum(counts.values())
    return {"counts": counts, "n": n,
            "pct_correct": 100.0 * counts["correct"] / n if n else 0.0,
            "elapsed": elapsed}


def main():
    matcher = pa.AudioToScoreMatcher()
    for pid in PIECES:
        r = run_piece(matcher, pid)
        if r is None:
            print(f"{pid}: SKIP (missing file)")
            continue
        c = r["counts"]
        print(f"{pid}: n={r['n']} correct={c['correct']} ({r['pct_correct']:.1f}%) "
              f"off_by_one={c['off_by_one']} wrong={c['wrong']} "
              f"unmatched={c['unmatched']}  [{r['elapsed']:.1f}s]")


if __name__ == "__main__":
    main()
