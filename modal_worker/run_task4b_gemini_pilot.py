"""Task 4B -- production-faithful Gemini evaluation.

Owner-approved, 2026-10-30. 9 new real paid calls to the real, unmodified
`evaluate_with_gemini`: 3 cases (reused from Task 4A, same rng_seed=0 so
the injected audio is byte-identical) x 3 NEW conditions:

  A. Short audio (+-4 measures around the mistake / a representative
     measure for the control), no score image.
  B. Short audio, full-piece score image (MuseScore-rendered from the
     same MusicNet reference MIDI, every page, matching production's
     "send the whole score, never crop" convention).
  C. Full recording, full-piece score image.

Condition "full recording, no score" is NOT re-run here -- those are
Task 4A's already-paid results for these same 3 pieces (2203, 2296,
2289), reused verbatim for the 4-way comparison.

Gemini 2.5 Flash only (no Pro fallback), hard cap $1.50, max 9 calls,
same non-invasive httpx usage-capture pattern as Task 4A for real cost.
"""
import os
import sys
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import httpx

sys.path.insert(0, str(Path(__file__).parent))
import worker as w
from inject_audio_mistakes import inject_mistake
from validate_alignment_against_musicnet import midi_score_to_dict, load_ground_truth

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

w.GEMINI_MODELS = ["gemini-2.5-flash"]

DATA_DIR = Path("/Users/matthewwu/.cache/mediant_validation/data")
SCORE_DIR = Path(
    "/private/tmp/claude-501/-Users-matthewwu-repos-mediant-ui-shell/"
    "38e243d9-e93e-49c3-8a57-734126447ef9/scratchpad/task4b_scores"
)
GOOGLE_AI_API_KEY = os.environ["GOOGLE_AI_API_KEY"]  # never hardcode -- set via env
MUSICNET_SR = 44100

AUDIO_TOKENS_PER_SEC = 32
INPUT_AUDIO_PER_TOKEN = 1.00 / 1_000_000
INPUT_IMAGE_PER_TOKEN = 0.30 / 1_000_000
OUTPUT_PER_TOKEN = 2.50 / 1_000_000
WORST_CASE_OUTPUT_TOKENS = 40_000
WORST_CASE_IMAGE_TOKENS_PER_PAGE = 1500
MAX_CALLS = 9
MAX_TOTAL_COST = 1.50

# (piece_id, instrument, mistake_type_or_control, mistake_measure_or_representative,
#  excerpt_start_measure, excerpt_end_measure, excerpt_start_sec, excerpt_end_sec)
CASES = [
    ("2203", "Flute", "wrong_pitch", 74, 70, 78, 124.60, 139.53),
    ("2296", "Cello", "deleted_note", 56, 52, 60, 229.67, 267.21),
    ("2289", "Violin", "control", 80, 76, 84, 94.04, 105.27),
]

CONDITIONS = ["short_no_score", "short_with_score", "full_with_score"]


class BudgetExceeded(Exception):
    pass


def _load_piece(piece_id, data_dir):
    midi_path = data_dir / "midis" / f"{piece_id}.mid"
    audio_path = data_dir / "audio" / f"{piece_id}.wav"
    label_path = data_dir / "labels" / f"{piece_id}.csv"
    wav_bytes = audio_path.read_bytes()
    ground_truth = load_ground_truth(str(label_path))

    import csv
    end_sec_by_note = {}
    with open(label_path) as f:
        for row in csv.DictReader(f):
            key = (int(row["start_time"]), int(row["note"]))
            end_sec_by_note[key] = int(row["end_time"]) / MUSICNET_SR
    for note in ground_truth:
        key = (int(round(note["onset_sec"] * MUSICNET_SR)), note["note"])
        note["end_sec"] = end_sec_by_note.get(key, note["onset_sec"])

    score = midi_score_to_dict(str(midi_path))
    return wav_bytes, ground_truth, score


def _crop_wav(samples, sr, start_sec, end_sec):
    start_idx = max(0, int(start_sec * sr))
    end_idx = min(len(samples), int(end_sec * sr))
    cropped = samples[start_idx:end_idx]
    import io
    buf = io.BytesIO()
    sf.write(buf, cropped, sr, format="WAV")
    return buf.getvalue()


def _score_pages_for(piece_id):
    pages = sorted(SCORE_DIR.glob(f"{piece_id}_score-*.png"))
    return [(p.read_bytes(), "image/png") for p in pages]


def _worst_case_cost(duration_sec, n_score_pages):
    audio_tokens = duration_sec * AUDIO_TOKENS_PER_SEC
    image_tokens = n_score_pages * WORST_CASE_IMAGE_TOKENS_PER_PAGE
    input_cost = audio_tokens * INPUT_AUDIO_PER_TOKEN + image_tokens * INPUT_IMAGE_PER_TOKEN
    output_cost = WORST_CASE_OUTPUT_TOKENS * OUTPUT_PER_TOKEN
    return input_cost + output_cost


def run_pilot():
    results = []
    total_real_cost = 0.0
    total_worst_case_reserved = 0.0
    n_calls = 0

    for piece_id, instrument, mistake_type, mistake_measure, exc_start_m, exc_end_m, exc_start_s, exc_end_s in CASES:
        print(f"\n--- loading {piece_id} ({instrument}, {mistake_type}) ---")
        wav_bytes, ground_truth, score = _load_piece(piece_id, DATA_DIR)
        n_measures_total = len(score["measures"])

        if mistake_type == "control":
            full_wav_bytes = wav_bytes
            injected_meta = None
        else:
            inj = inject_mistake(wav_bytes, ground_truth, mistake_type, rng_seed=0)
            full_wav_bytes = inj["wav_bytes"]
            injected_meta = inj["injected"]

        import io
        full_samples, sr = sf.read(io.BytesIO(full_wav_bytes))
        short_wav_bytes = _crop_wav(full_samples, sr, exc_start_s, exc_end_s)
        full_duration = len(full_samples) / sr
        short_duration = exc_end_s - exc_start_s

        score_pages = _score_pages_for(piece_id)

        for condition in CONDITIONS:
            if n_calls >= MAX_CALLS:
                raise BudgetExceeded(f"MAX_CALLS ({MAX_CALLS}) reached")

            if condition == "short_no_score":
                audio_bytes = short_wav_bytes
                duration = short_duration
                pages = None
                start_m, end_m = exc_start_m, exc_end_m
            elif condition == "short_with_score":
                audio_bytes = short_wav_bytes
                duration = short_duration
                pages = score_pages
                start_m, end_m = exc_start_m, exc_end_m
            else:  # full_with_score
                audio_bytes = full_wav_bytes
                duration = full_duration
                pages = score_pages
                start_m, end_m = 1, n_measures_total

            n_pages = len(pages) if pages else 0
            worst_case = _worst_case_cost(duration, n_pages)
            if total_worst_case_reserved + worst_case > MAX_TOTAL_COST:
                raise BudgetExceeded(
                    f"next call worst-case ${worst_case:.4f} would push reserved "
                    f"total to ${total_worst_case_reserved + worst_case:.4f} > ${MAX_TOTAL_COST}"
                )
            total_worst_case_reserved += worst_case

            print(f"  [{n_calls + 1}/{MAX_CALLS}] {piece_id} {condition}: "
                  f"dur={duration:.1f}s pages={n_pages} worst_case=${worst_case:.4f}")

            usage_before = len(_CAPTURED_USAGE)
            t0 = time.time()
            file_uri = w.upload_video_to_gemini(audio_bytes, "audio/wav", GOOGLE_AI_API_KEY)
            assessment = w.evaluate_with_gemini(
                file_uri=file_uri,
                mime_type="audio/wav",
                instrument=instrument,
                piece_title=f"MusicNet {piece_id}",
                composer="Johann Sebastian Bach",
                start_measure=start_m,
                end_measure=end_m,
                api_key=GOOGLE_AI_API_KEY,
                user_note="",
                score_bytes=None,
                score_mime=None,
                score_pages=pages,
            )
            latency = time.time() - t0
            n_calls += 1

            real_input_tokens = 0
            real_output_tokens = 0
            real_cost = None
            new_usage = _CAPTURED_USAGE[usage_before:]
            if new_usage:
                u = new_usage[-1]
                real_input_tokens = u.get("promptTokenCount", 0)
                real_output_tokens = u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)
                real_cost = (
                    real_input_tokens * INPUT_AUDIO_PER_TOKEN
                    + real_output_tokens * OUTPUT_PER_TOKEN
                )
                total_real_cost += real_cost

            result = {
                "piece_id": piece_id,
                "instrument": instrument,
                "mistake_type": mistake_type,
                "condition": condition,
                "injected": injected_meta,
                "excerpt_measures": [exc_start_m, exc_end_m] if condition != "full_with_score" else None,
                "excerpt_sec": [exc_start_s, exc_end_s] if condition != "full_with_score" else None,
                "duration_sec": duration,
                "n_score_pages": n_pages,
                "assessment": assessment,
                "latency_sec": latency,
                "real_input_tokens": real_input_tokens,
                "real_output_tokens": real_output_tokens,
                "real_cost": real_cost,
                "worst_case_cost_gate": worst_case,
            }
            results.append(result)
            print(f"    done: latency={latency:.1f}s real_cost=${real_cost}")

    out_path = Path(__file__).parent / "task4b_pilot_results.json"
    out_path.write_text(json.dumps(results, indent=2, default=str))

    print(f"\n=== TOTAL: {n_calls} calls, real cost ${total_real_cost:.4f}, "
          f"worst-case reserved ${total_worst_case_reserved:.4f} ===")
    print(f"Results written to {out_path}")
    return results


if __name__ == "__main__":
    run_pilot()
