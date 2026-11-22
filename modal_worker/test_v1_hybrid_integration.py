"""
ONE focused, zero-API-cost integration check for the V1/V2 hybrid patch in
run_full_analysis (score-based practice suggestions added alongside V1's
real grading -- see worker.py's `score_practice_insights` block right after
the Gemini-measure cross-validation step).

This is NOT a new full V1 harness: every expensive/network stage (CREPE
pitch/beat tracking, Gemini upload+assessment, Gemini measure positions,
Claude score-reading, Claude coaching) is monkeypatched directly onto the
worker module's own functions to fixed, instant, zero-cost values -- the
same per-function monkeypatching style test_analysis.py already uses for
read_score_notes_claude (test_score_reader_sends_every_page). Only the ONE
function this patch actually added, analyze_score_for_practice, runs for
real, against a realistic multi-measure score -- so what lands in the
posted webhook body for scorePracticeInsights is genuinely generated, not
canned. V1's flags/coaching are mocked wholesale (compare_and_coach_claude
itself) rather than re-exercised, since this task is integration wiring,
not a re-review of coaching correctness (already covered by
test_analysis.py/test_evidence.py's own suites).

Runs in a FRESH interpreter subprocess, same reason test_analysis_v2.py
gives: another test file in the same pytest session may have mocked
`modal` in sys.modules, which would make run_full_analysis.local(...) a
no-op instead of running the real function body.

Run:
    /Users/matthewwu/.cache/mediant_validation/venv/bin/python -m pytest \
        modal_worker/test_v1_hybrid_integration.py -v
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

_CHILD = r"""
import json, sys, types
sys.path.insert(0, sys.argv[1])
scenario = json.loads(sys.argv[2])

import httpx

VIDEO_URL = "https://fixture.invalid/video"
SCORE_URL = "https://fixture.invalid/score"
WEBHOOK_URL = "https://fixture.invalid/webhook"

webhook_capture = []

class _FakeResponse:
    def __init__(self, content, status_code=200, content_type="image/png"):
        self.content = content
        self.status_code = status_code
        self.text = ""
        self.headers = {"content-type": content_type}
    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("fixture error", request=None, response=self)
    def json(self):
        return {}

class _FakeClient:
    def __init__(self, *a, **kw): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get(self, url, follow_redirects=True):
        if url == VIDEO_URL:
            return _FakeResponse(b"\x00\x00fake-video-bytes")
        if url == SCORE_URL:
            return _FakeResponse(b"\x89PNG-fake-score-page")
        raise RuntimeError(f"test fixture has no GET response for {url!r}")
    def post(self, url, json=None, headers=None):
        webhook_capture.append(json)
        return _FakeResponse(b"{}", status_code=200)

httpx.Client = _FakeClient

import importlib.util
from pathlib import Path as _P
spec = importlib.util.spec_from_file_location("worker_hybrid_integration_under_test", str(_P(sys.argv[1]) / "worker.py"))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

# ---- Monkeypatch every expensive/network stage on the worker module itself.
# run_full_analysis's closures resolve these names against the module's own
# globals at call time, so patching the attribute here is enough -- no SDK
# faking needed for CREPE/Gemini, and no Anthropic client construction at
# all for score-reading or coaching (both mocked directly).
w.extract_audio_from_video = lambda video_bytes, target_sr=22050: (b"\x00\x00", 2.0)
w.run_beat_tracking = lambda wav_bytes, estimated_bpm=None: {
    "duration_sec": 2.0, "beat_times": [0.0, 0.5, 1.0, 1.5],
    "onset_times": [0.0, 0.5, 1.0, 1.5], "tempo_bpm": 120.0,
}
w.run_pitch_tracking = lambda wav_bytes, guide_times=None, instrument="": []
w.upload_video_to_gemini = lambda video_bytes, mime_type, api_key: "fake-gemini-uri"
w.evaluate_with_gemini = lambda *a, **kw: {
    "intonation_issues": [], "rhythm_issues": [], "wrong_notes_cracks": [],
    "dynamics_issues": [], "tone_issues": [],
}
w.sniff_score_kind = lambda score_bytes, score_mime, score_url: "visual"
w.get_measure_positions_gemini = lambda *a, **kw: {}

_STEPWISE = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"]

def _fake_score(*a, **kw):
    # Canonical post-normalization shape (pitch/beat/part/voice), the same
    # shape read_score_notes_claude actually returns after parsing Claude's
    # raw p/b/d JSON -- analyze_score_for_practice and compare_and_coach_claude
    # both read these full field names, not the raw abbreviations.
    measures = []
    for i in range(1, 9):
        if i == 5:
            notes = [
                {"pitch": "C4", "beat": 1.0, "duration": 1.0, "part": 0, "voice": None},
                {"pitch": "C6", "beat": 2.0, "duration": 1.0, "part": 0, "voice": None},
            ]
        else:
            a1, b1 = _STEPWISE[(i - 1) % 7], _STEPWISE[i % 7]
            notes = [
                {"pitch": a1, "beat": 1.0, "duration": 1.0, "part": 0, "voice": None},
                {"pitch": b1, "beat": 2.0, "duration": 1.0, "part": 0, "voice": None},
            ]
        measures.append({"number": i, "page": 1, "notes": notes})
    return {
        "key_signature": "C major", "time_signature": "4/4", "tempo_marking": None,
        "measures": measures,
    }

if scenario.get("break_score_practice"):
    import score_practice_analysis as _spa
    def _raise(score_dict):
        raise RuntimeError("synthetic failure for the negative test")
    _spa.analyze_score_for_practice = _raise

w.read_score_notes_claude = _fake_score

CANNED_FLAGS = [{
    "id": "f1", "type": "intonation", "measure": 3,
    "message": "slightly sharp on the C#", "cents_deviation": 18,
}]
w.compare_and_coach_claude = lambda **kw: list(CANNED_FLAGS)

payload = {
    "take_id": "test-hybrid-take",
    "webhook_url": WEBHOOK_URL, "webhook_secret": None, "webhook_anon_key": None,
    "video_url": VIDEO_URL, "video_mime_type": "video/mp4",
    "score_url": SCORE_URL, "score_urls": [SCORE_URL],
    "score_mime_type": "image/png", "score_path": "test/score.png",
    "instrument": "Violin", "piece_title": "Test Piece", "composer": "Test Composer",
    "time_sig": "4/4", "start_measure": 1,
    "gemini_api_key": "fake-gemini-key", "anthropic_api_key": "fake-anthropic-key",
}
w.run_full_analysis.local(payload)
print("RESULT " + json.dumps(webhook_capture))
"""


def _run(scenario: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, "-c", _CHILD, str(HERE), json.dumps(scenario)],
        capture_output=True, text=True, timeout=120,
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")]
    assert proc.returncode == 0 and lines, f"child failed rc={proc.returncode}: {proc.stderr[-4000:]}"
    capture = json.loads(lines[-1][len("RESULT "):])
    assert len(capture) == 1, capture
    return capture[0]


def test_hybrid_webhook_includes_practice_insights_alongside_unchanged_v1_flags():
    """The combined webhook payload carries BOTH: V1's real flags/coaching
    output (mocked at compare_and_coach_claude, so the webhook's `flags`
    must come through byte-for-byte identical to what that mock returned --
    proving the hybrid patch does not touch it), AND a genuinely generated
    scorePracticeInsights (computed by the real, unmodified
    analyze_score_for_practice against a real multi-measure score with one
    injected large leap in measure 5)."""
    body = _run({})

    assert body["flags"] == [{
        "id": "f1", "type": "intonation", "measure": 3,
        "message": "slightly sharp on the C#", "cents_deviation": 18,
    }], "V1's coaching flags must pass through completely unchanged"
    assert body["score"] is not None and 45 <= body["score"] <= 98, body["score"]
    assert body["measureLayout"]["measures"], "V1's real score parse must still be present"

    insights = body["scorePracticeInsights"]
    assert insights["status"] == "available", insights
    assert insights["targets"], "expected the injected leap in measure 5 to surface as a target"
    assert insights["targets"][0]["characteristic"] == "large_melodic_interval", insights["targets"][0]
    assert "flags" not in insights, "practice insights must never carry a flags key"

    # V1 never sets performanceErrorAssessment -- confirms Analysis.jsx's
    # isExperimentalV2Take stays false for this hybrid take, so it is never
    # mistaken for the no-grading V2 path.
    assert "performanceErrorAssessment" not in body, body
    assert "v2" not in (body.get("analysisBackend") or "")


def test_hybrid_failure_isolation_keeps_v1_report_intact():
    """Negative test: force analyze_score_for_practice to raise. The webhook
    must still be posted with V1's original flags/score/measureLayout fully
    intact, and scorePracticeInsights must degrade to an honest
    'unavailable' result recorded via the failure-isolation try/except --
    not a crash that drops the whole webhook."""
    body = _run({"break_score_practice": True})

    assert body["flags"] == [{
        "id": "f1", "type": "intonation", "measure": 3,
        "message": "slightly sharp on the C#", "cents_deviation": 18,
    }], "a score-practice failure must not touch V1's coaching flags"
    assert body["measureLayout"]["measures"], "a score-practice failure must not touch V1's score parse"
    assert body["score"] is not None and 45 <= body["score"] <= 98, body["score"]

    insights = body["scorePracticeInsights"]
    assert insights["status"] == "unavailable", insights
    assert insights["targets"] == []
    assert "synthetic failure for the negative test" in (insights.get("reason") or "")
    assert "score_practice: FAILED" in " ".join(body["pipelineDebug"])
