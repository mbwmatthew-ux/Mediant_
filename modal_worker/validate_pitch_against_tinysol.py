"""
Validates run_pitch_tracking (the production CREPE-based pitch detector)
against TinySOL — real musicians playing individually labeled, isolated
notes across every orchestral instrument this product supports (Cella et
al. 2020, Zenodo doi:10.5281/zenodo.3685367, CC-BY 4.0).

Why this exists: as of 2026-10-11, zero takes in production have ever been
teacher-annotated (see agent_workspace/ACCURACY_BASELINE.md) — there is no
measured accuracy number for this pipeline anywhere. TinySOL needs no human
judgment call at all: each clip's correct pitch is already known from the
dataset's own metadata, so this gives a first REAL, objective number for
the part of the pipeline most likely to matter for an intermediate player
("did it correctly hear the note") without touching the subjective
coaching layer at all.

Scope, deliberately narrow: this validates run_pitch_tracking's pitch
detection in isolation. It does NOT validate score-alignment (matching a
detected note to the right measure in a real piece) — TinySOL's notes are
isolated, not played against a score. See the Session note from
2026-10-11 ("Full product audit") for why URMP (which would cover that
too) wasn't used instead — it's gated behind a dead sample link and a
bot-walled main host.

Not part of the Modal image — same category as replay.py /
score_against_annotations.py. Needs the TinySOL dataset downloaded via
mirdata (`mirdata.initialize('tinysol', data_home=...).download()`) and
the same torch/torchaudio/torchcrepe/librosa/soundfile/numpy/scipy pins
worker.py's pip_install block uses, installed wherever this runs — kept
in an isolated venv during development specifically so this one-off
validation tooling never has to share dependency resolution with the
actual production worker image or this repo's own dev tooling.

Usage:
    python validate_pitch_against_tinysol.py --data-dir /tmp/mirdata_tinysol [--limit N]
"""
import argparse
import csv
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402

# TinySOL's "Instrument (in full)" -> this app's own canonical instrument
# string (src/lib/instruments.js INSTRUMENTS). Matters because
# _instrument_pitch_bounds's substring matching is sensitive to the exact
# string a real user's instrument selection would produce — e.g. TinySOL's
# "Bass Tuba" contains "bass" and would misroute into the double-bass pitch
# range if passed verbatim (_instrument_pitch_bounds checks "bass" in i
# before it checks "tuba" in i); no real user of this app ever selects
# "Bass Tuba" literally, they select "Tuba". Accordion has no equivalent in
# this app's instrument list and is skipped entirely below — not a
# supported instrument, there is nothing to validate it against.
INSTRUMENT_MAP = {
    "Violin": "Violin",
    "Viola": "Viola",
    "Cello": "Cello",
    "Contrabass": "Double Bass",
    "Flute": "Flute",
    "Oboe": "Oboe",
    "Clarinet in Bb": "Clarinet",
    "Alto Saxophone": "Saxophone",
    "Bassoon": "Bassoon",
    "Trumpet in C": "Trumpet",
    "French Horn": "French Horn",
    "Trombone": "Trombone",
    "Bass Tuba": "Tuba",
}

DYNAMICS_ORDER = ["pp", "p", "mf", "f", "ff"]


def load_rows(metadata_csv: Path) -> list[dict]:
    rows = []
    with open(metadata_csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            mapped = INSTRUMENT_MAP.get(row["Instrument (in full)"])
            if mapped is None:
                continue
            rows.append({
                "path":        row["Path"],
                "instrument":  mapped,
                "family":      row["Family"],
                "pitch_name":  row["Pitch"],
                "midi_truth":  int(row["Pitch ID"]),
                "dynamics":    row["Dynamics"],
            })
    return rows


def classify(midi_truth: int, detected_raws: list[int]) -> str:
    """
    One of: correct / octave_error / wrong / missed.

    Median across every event detected in the clip, not just the first —
    a single isolated note should produce one dominant pitch; a stray
    onset/offset artifact at the very start/end of a clip (a bow attack
    transient, a breath) shouldn't outvote the sustained body just because
    it happened to register as a separate event.
    """
    if not detected_raws:
        return "missed"
    detected_raws = sorted(detected_raws)
    median = detected_raws[len(detected_raws) // 2]
    if median == midi_truth:
        return "correct"
    if (median - midi_truth) % 12 == 0:
        return "octave_error"
    return "wrong"


def pct(counts: dict, key: str) -> float:
    total = sum(counts.values())
    return 100.0 * counts.get(key, 0) / total if total else 0.0


def print_breakdown(title: str, grouped: dict, order: list[str] | None = None):
    print(f"\n{title}")
    keys = order if order else sorted(grouped)
    for key in keys:
        if key not in grouped:
            continue
        c = grouped[key]
        total = sum(c.values())
        print(f"  {key:16s} n={total:4d}  correct={pct(c,'correct'):5.1f}%  "
              f"octave_err={pct(c,'octave_error'):5.1f}%  wrong={pct(c,'wrong'):5.1f}%  "
              f"missed={pct(c,'missed'):5.1f}%  error={pct(c,'error'):4.1f}%")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True,
                     help="mirdata TinySOL data_home (contains annotation/ and audio/)")
    ap.add_argument("--limit", type=int, default=None,
                     help="cap the number of clips processed, for a quick smoke run")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    metadata_csv = data_dir / "annotation" / "TinySOL_metadata.csv"
    rows = load_rows(metadata_csv)
    if args.limit:
        rows = rows[:args.limit]

    print(f"[validate] {len(rows)} clips to process "
          f"({len(set(r['instrument'] for r in rows))} instruments)")

    results = []
    t_start = time.time()
    for i, row in enumerate(rows):
        wav_path = data_dir / "audio" / row["path"]
        try:
            wav_bytes = wav_path.read_bytes()
        except FileNotFoundError:
            print(f"  MISSING FILE: {wav_path}")
            continue

        try:
            events = w.run_pitch_tracking(wav_bytes, instrument=row["instrument"])
            detected_raws = [e["midi_raw"] for e in events if e.get("midi_raw") is not None]
            outcome = classify(row["midi_truth"], detected_raws)
        except Exception as e:
            print(f"  ERROR on {row['path']}: {type(e).__name__}: {e}")
            outcome = "error"
            events = []

        results.append({**row, "outcome": outcome, "n_events": len(events)})

        if (i + 1) % 200 == 0:
            elapsed = time.time() - t_start
            print(f"  ...{i + 1}/{len(rows)}  ({elapsed:.0f}s elapsed, "
                  f"~{elapsed / (i + 1) * (len(rows) - i - 1):.0f}s remaining)")

    by_instrument = defaultdict(lambda: defaultdict(int))
    by_dynamics   = defaultdict(lambda: defaultdict(int))
    by_family     = defaultdict(lambda: defaultdict(int))
    overall       = defaultdict(int)
    for r in results:
        by_instrument[r["instrument"]][r["outcome"]] += 1
        by_dynamics[r["dynamics"]][r["outcome"]] += 1
        by_family[r["family"]][r["outcome"]] += 1
        overall[r["outcome"]] += 1

    print("\n" + "=" * 70)
    print(f"OVERALL  (n={len(results)}, {time.time() - t_start:.0f}s total)")
    for k in ("correct", "octave_error", "wrong", "missed", "error"):
        print(f"  {k:14s} {overall.get(k, 0):5d}  ({pct(overall, k):.1f}%)")

    print_breakdown("BY FAMILY", by_family)
    print_breakdown("BY INSTRUMENT", by_instrument)
    print_breakdown("BY DYNAMICS", by_dynamics, order=DYNAMICS_ORDER)
    print("=" * 70)

    # Dump every non-correct case so a specific failure can be re-examined
    # (e.g. fed back into run_pitch_tracking directly) without re-running
    # the whole pass.
    misses_path = Path(__file__).parent / "tinysol_validation_misses.csv"
    with open(misses_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "path", "instrument", "family", "pitch_name", "midi_truth",
            "dynamics", "outcome", "n_events",
        ])
        writer.writeheader()
        for r in results:
            if r["outcome"] != "correct":
                writer.writerow({k: r[k] for k in writer.fieldnames})
    print(f"\nNon-correct cases written to {misses_path}")


if __name__ == "__main__":
    main()
