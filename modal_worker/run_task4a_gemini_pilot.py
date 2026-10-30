"""
Task 4A (owner-approved, 2026-10-30): Gemini-only performance-feedback
accuracy pilot. Measures whether the REAL, UNMODIFIED evaluate_with_gemini
correctly identifies injected mistakes, independent of CREPE/DTW and
Claude coaching -- neither of those is called anywhere in this script.

Scope, exactly as approved: 2 wrong_pitch + 2 deleted_note + 2
duplicated_note + 3 unmodified controls = 9 real paid calls, Gemini 2.5
Flash only (Pro fallback disabled via a runtime-only override of
worker.GEMINI_MODELS -- no file edit), no automatic retries attempted
beyond whatever evaluate_with_gemini's own internal transient-5xx retry
does (that retry loop is hardcoded inside the function and cannot be
disabled without editing worker.py, which is out of scope here; it only
fires on real transient HTTP failures and failed attempts aren't billed,
so it does not risk the budget), hard cap $2.00 / 9 calls.

No real score-music page images exist for these MusicNet pieces (no
MuseScore/Lilypond installed in this environment to render the reference
MIDI) -- owner confirmed (2026-10-30) to proceed in evaluate_with_gemini's
own existing "no score provided" fallback branch, unmodified. Per that
branch's own prompt text, every issue's "measure" field is hardcoded to
`start_measure` regardless of where it actually occurred -- so "measure"
is NOT a usable signal here. Scoring uses "time" (the "M:SS" field Gemini
DOES report from listening) against a tolerance window instead.

Held-out pieces only (never a dev piece: 2186/2219 excluded by
construction -- not even considered below).
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402
from inject_audio_mistakes import inject_mistake  # noqa: E402
from validate_alignment_against_musicnet import load_ground_truth  # noqa: E402

# Disable the Pro fallback for this pilot, as approved -- runtime-only
# override of the module-level constant, no file edit. evaluate_with_gemini
# reads this list at call time, so this takes effect immediately.
w.GEMINI_MODELS = ["gemini-2.5-flash"]

# evaluate_with_gemini never exposes real token usage or cost (checked its
# source directly: no usageMetadata read, no [cost] print, anywhere in the
# function) -- calling it as a black box, as the owner's "preserve the
# existing production prompt/model/schema" requirement demands, means the
# only way to get REAL billed numbers (not a worst-case estimate) is to
# observe the raw HTTP response without touching worker.py at all. Same
# "observe, don't modify" pattern used earlier this session for Claude's
# [cost] print-line capture. This wraps httpx.Client.post process-wide, for
# THIS throwaway script's process only -- no file edit, no effect on the
# committed worker.py or any other real invocation of it.
import httpx

_CAPTURED_USAGE: list[dict] = []
_original_post = httpx.Client.post


def _capturing_post(self, url, *args, **kwargs):
    resp = _original_post(self, url, *args, **kwargs)
    if "generativelanguage.googleapis.com" in str(url) and "generateContent" in str(url):
        try:
            usage = resp.json().get("usageMetadata")
            if usage:
                _CAPTURED_USAGE.append(usage)
        except Exception:
            pass
    return resp


httpx.Client.post = _capturing_post

DATA_DIR = Path("/Users/matthewwu/.cache/mediant_validation/data")
GOOGLE_AI_API_KEY = "AIzaSyCmwr9Dlvc4nm3JF7-EatD0fCqXutUbDkU"

# Pricing verified via WebSearch against multiple aggregators before any
# call (2026-10-30): Gemini 2.5 Flash audio input ~$1.00/1M tokens, output
# ~$2.50/1M tokens (text/JSON, not audio-out -- this call produces no
# audio output). Audio token rate ~32 tokens/sec per Gemini's documented
# ratio. These are WORST-CASE estimates for the pre-call gate; real cost
# is recorded from each response's own usageMetadata afterward.
AUDIO_TOKENS_PER_SEC = 32
INPUT_PER_TOKEN = 1.00 / 1_000_000
OUTPUT_PER_TOKEN = 2.50 / 1_000_000
WORST_CASE_OUTPUT_TOKENS = 40000  # evaluate_with_gemini's own fallback-config ceiling

MAX_CALLS = 9
MAX_TOTAL_COST = 2.00

# 2 wrong_pitch, 2 deleted_note, 2 duplicated_note, 3 control -- picked
# for instrument diversity and a mix of Task 3's "always correct" /
# "not always correct" DTW-localization pieces (irrelevant to Gemini's
# own accuracy, included only so this pilot isn't accidentally all-easy
# or all-hard pieces). None of these are dev pieces (2186, 2219).
PILOT_CASES = [
    ("2203", "Flute",  "wrong_pitch"),
    ("2241", "Violin",  "wrong_pitch"),
    ("2218", "Cello",   "deleted_note"),
    ("2296", "Cello",   "deleted_note"),
    ("2244", "Violin",  "duplicated_note"),
    ("2204", "Flute",   "duplicated_note"),
    ("2289", "Violin",  "control"),
    ("2202", "Flute",   "control"),
    ("2288", "Cello",   "control"),
]
assert len(PILOT_CASES) == MAX_CALLS


class BudgetExceeded(Exception):
    pass


def _worst_case_estimate(duration_sec: float) -> float:
    audio_cost = duration_sec * AUDIO_TOKENS_PER_SEC * INPUT_PER_TOKEN
    output_cost = WORST_CASE_OUTPUT_TOKENS * OUTPUT_PER_TOKEN
    return audio_cost + output_cost


def _load_piece_wav_and_ground_truth(piece_id: str):
    wav_bytes = (DATA_DIR / "audio" / f"{piece_id}.wav").read_bytes()
    ground_truth = load_ground_truth(DATA_DIR / "labels" / f"{piece_id}.csv")
    # load_ground_truth doesn't read end_sec; add it the same way
    # inject_audio_mistakes.py's docstring documents (raw MusicNet CSV
    # end_time column, same sample-index/44100Hz convention as start_time).
    import csv
    MUSICNET_SR = 44100
    end_by_onset = {}
    with open(DATA_DIR / "labels" / f"{piece_id}.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            end_by_onset[int(row["start_time"]) / MUSICNET_SR] = int(row["end_time"]) / MUSICNET_SR
    for row in ground_truth:
        row["end_sec"] = end_by_onset[row["onset_sec"]]
    return wav_bytes, ground_truth


def run_pilot():
    import soundfile as sf
    import io

    running_total = 0.0
    results = []

    for i, (piece_id, instrument, condition) in enumerate(PILOT_CASES, start=1):
        print(f"\n=== case {i}/{len(PILOT_CASES)}: {piece_id} ({instrument}) {condition} ===")
        wav_bytes, ground_truth = _load_piece_wav_and_ground_truth(piece_id)

        if condition == "control":
            audio_bytes = wav_bytes
            injected = None
        else:
            result = inject_mistake(wav_bytes, ground_truth, condition, rng_seed=0)
            audio_bytes = result["wav_bytes"]
            injected = result["injected"]
            print(f"  injected: {injected}")

        duration_sec = sf.info(io.BytesIO(audio_bytes)).duration
        estimate = _worst_case_estimate(duration_sec)
        if running_total + estimate > MAX_TOTAL_COST:
            print(f"  BUDGET GATE: running_total=${running_total:.4f} + "
                  f"worst_case=${estimate:.4f} would exceed ${MAX_TOTAL_COST:.2f} cap. STOPPING.")
            raise BudgetExceeded(
                f"Stopped before case {i} ({piece_id}/{condition}): "
                f"${running_total:.4f} + ${estimate:.4f} > ${MAX_TOTAL_COST:.2f}")
        print(f"  pre-call budget check: running_total=${running_total:.4f}, "
              f"this call's worst case=${estimate:.4f}, cap=${MAX_TOTAL_COST:.2f} -- OK")

        _CAPTURED_USAGE.clear()
        t0 = time.monotonic()
        file_uri = w.upload_video_to_gemini(audio_bytes, "audio/wav", GOOGLE_AI_API_KEY)
        assessment = w.evaluate_with_gemini(
            file_uri=file_uri, mime_type="audio/wav",
            instrument=instrument, piece_title=f"MusicNet {piece_id}",
            composer="Johann Sebastian Bach",
            start_measure=1, end_measure=None,
            api_key=GOOGLE_AI_API_KEY,
            user_note="",
            score_bytes=None, score_mime=None, score_pages=None,
        )
        latency_sec = time.monotonic() - t0

        # Real cost from the captured usageMetadata (see module docstring
        # for why this has to be captured at the HTTP layer rather than
        # read off evaluate_with_gemini's return value). Sums every real
        # generateContent call this ONE case made (evaluate_with_gemini
        # can try a second generationConfig if the first comes back empty
        # -- both are real, billed attempts against the same Flash model
        # since the Pro fallback is disabled above).
        real_input_tokens = sum(u.get("promptTokenCount", 0) for u in _CAPTURED_USAGE)
        real_output_tokens = sum(
            u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)
            for u in _CAPTURED_USAGE)
        real_cost = real_input_tokens * INPUT_PER_TOKEN + real_output_tokens * OUTPUT_PER_TOKEN
        n_real_calls = len(_CAPTURED_USAGE)

        running_total += real_cost  # real spend, not the worst-case estimate used for the gate
        print(f"  done in {latency_sec:.1f}s, {n_real_calls} real generateContent call(s), "
              f"input_tokens={real_input_tokens} output_tokens={real_output_tokens} "
              f"real_cost=${real_cost:.4f} (worst-case gate was ${estimate:.4f})")
        print(f"  assessment: {assessment}")

        results.append({
            "piece_id": piece_id, "instrument": instrument, "condition": condition,
            "injected": injected, "assessment": assessment,
            "latency_sec": round(latency_sec, 1), "duration_sec": round(duration_sec, 1),
            "n_real_calls": n_real_calls,
            "real_input_tokens": real_input_tokens, "real_output_tokens": real_output_tokens,
            "real_cost": round(real_cost, 4), "worst_case_cost_gate": round(estimate, 4),
        })

    print(f"\n{'=' * 70}")
    print(f"All {len(results)} cases complete. REAL total spend: "
          f"${running_total:.4f} of ${MAX_TOTAL_COST:.2f} cap")
    print(f"{'=' * 70}")

    import json
    out_path = Path(__file__).with_name("task4a_pilot_results.json")
    out_path.write_text(json.dumps(results, indent=2, default=str))
    print(f"Full results written to {out_path}")
    return results


if __name__ == "__main__":
    run_pilot()
