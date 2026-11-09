# Limited Staging Canary — 2026-11-08

**Status: Tasks 1-3 done and verified locally, $0. Task 4 (the live staging
canary) STOPPED before any spend or deploy — not a budget refusal, a real
engineering gap found while implementing Task 1.**

---

## Task 1 — feature flag into the real staging entry point

`modal_worker/worker.py`, `+242/-0` (pure additions, confirmed via
`git diff --stat`). First change to this file in this week's audio-pipeline
work.

`MEDIANT_ANALYSIS_V2_ENABLED` (default unset/off), read fresh inside
`run_full_analysis` — same convention as the existing `MEDIANT_SCORE_ENGINE`
flag just above it in the file (a redeploy with a new env value must take
effect without relying on cold-start timing).

- **Off:** `run_full_analysis` runs exactly as before. Confirmed by diff:
  zero lines inside the existing try/except block changed, only a 7-line
  guard inserted before it.
- **On:** delegates to a new top-level function, `_run_analysis_v2(payload)`,
  and returns immediately — none of the existing CREPE/DTW/Claude-coaching
  logic executes, so there is no interleaving risk between the two paths.

`_run_analysis_v2` runs: download video+score -> `score_pages_with_page_omr`
(production page-omr entry point) -> the same kern-to-partitura bridge
`local_e2e_integration_harness.py` built and validated this week -> Basic
Pitch (subprocess, `score_conditioned_error_classifier.BP_PY`/`BP_SCRIPT`) ->
Parangonar `AudioToScoreMatcher` with the per-piece `max_bp` bound -> the
Basic-Pitch onset-evidence gate. `max_bp_for_piece` and `bp_onset_support`
are **imported directly** from `local_e2e_integration_harness.py`, not
reimplemented.

## Task 2 — honest coaching output

`_run_analysis_v2` **never calls `compare_and_coach_claude`**. This was a
deliberate scope decision, not an oversight: the only way that function
produces non-empty coaching text is from Gemini/CREPE issue lists, and this
pipeline has neither — feeding it empty lists (as last round's harness test
proved) returns 0 flags anyway. Rather than make a call known to be vacuous,
V2 skips it entirely. This structurally guarantees the hard requirement:

- `flags` is **always** `[]`.
- `performanceErrorAssessment.status` is **always** `"unavailable"` — never
  `"passed"`, regardless of alignment outcome. Even when alignment is
  `"accepted"`, the `reason` field says explicitly: *"alignment succeeded
  but that is evidence of alignment quality, not of correct playing."*
- `scoreCompleteness.coverage_fraction` is **always** `null` for a real
  upload (`coverage_source: "unavailable - no verified reference for a
  real upload"`) — the MusicNet-style label-CSV check from last round's
  harness work only applies to fixtures with independent ground truth,
  which a real user upload never has. What a real upload DOES have —
  page-omr's own `partial_error` flag and whether all uploaded pages were
  processed — is used instead, honestly labeled as "not independently
  verified."
- `meterDependentClaimsAvailable` is `false` whenever page-omr's own
  `time_signature` comes back `None` (true for the 2220 fixture).
- The experimental logistic classifier (`score_conditioned_error_classifier`'s
  actual model) is never imported — only its `BP_PY`/`BP_SCRIPT` constants
  (plain subprocess config, not the classifier).

## Real gap found while implementing Task 1, not assumed

Checked directly, before writing any code that would depend on it:

- `score_conditioned_error_classifier.BP_PY = "/Users/matthewwu/.cache/
  mediant_validation/venv_basic_pitch/bin/python3"` — an absolute path into
  a local dev machine's isolated venv (kept separate because of a
  `tensorflow-macos<2.15.1` pin conflicting with the main venv). This path
  does not exist in any Modal container, staging or production.
- `worker.py`'s image definition (`.pip_install(...)`, lines ~69-122) has no
  `partitura` and no `parangonar`. Only page-omr's own deps (installed
  conditionally for a staging build via `MEDIANT_BUILD_SCORE_ENGINE`) are
  present beyond the base audio/utility stack.

**Every boundary in `_run_analysis_v2` that touches one of these is wrapped**
(`try`/`except` around the bridge import, an explicit `os.path.exists(BP_PY)`
check before the subprocess call) so a missing dependency degrades to an
honest `"unavailable"` status with a stated reason, instead of crashing the
request. This means the flag **can be turned on in the real staging
deployment today without breaking anything** — it will just report
`"unavailable"` for every real request, because Basic Pitch cannot actually
run there yet. Fixing that is image-build work (adding `partitura`/
`parangonar` to `.pip_install`, and separately, replacing the subprocess-to-
a-local-venv pattern for Basic Pitch with something that can run inside one
container) — **not done this round**, and not something this directive
authorized.

## Task 3 — verified via the real handler, not a direct function call

New file `modal_worker/test_analysis_v2.py`, 4 tests. Calls
`run_full_analysis.local(payload)` — the real `@app.function`/
`@modal.fastapi_endpoint`-decorated Modal function, run in-process via
Modal's own documented local-call mode (no container, no network to Modal,
no billing) — not a shortcut to `_run_analysis_v2` directly. `httpx` is
faked to serve local MusicNet fixture bytes for the video/score "download"
and to capture the webhook POST body instead of hitting the network.

**Found and fixed during this work:** running these tests in the same
pytest session as `test_analysis.py` silently broke them — `test_analysis.py`
blanket-replaces `modal` in `sys.modules` with a `MagicMock` at import time,
so `run_full_analysis.local(...)` became a no-op mock call (confirmed:
`webhook_capture` stayed empty) instead of running real code. Each test now
runs in its own subprocess (same fix pattern `test_score_completeness.py`
used for `music21` last round), confirmed fixed by re-running after
`test_analysis.py` in the same session.

**Results, all re-run independently and matching exactly:**

| Case | Result |
|---|---|
| A: complete pair (2220 score + 2220 audio) | Succeeds. 48 measures, 196-note array, alignment **accepted** (Basic Pitch onset support 81.1% aligned vs 19.4% null). `performanceErrorAssessment.status = "unavailable"`. `flags = []`. |
| B: known-incomplete score (2220) | `scoreCompleteness.coverage_fraction` is `null` (never fabricated). Status never `"passed"`. |
| C: mismatched audio (2186 audio + 2220 score) | `alignmentStatus != "accepted"`; `flags = []`; status never `"passed"`. |
| D: unknown meter | `meterDependentClaimsAvailable = False` (page-omr returned `time_signature=None` for this fixture). Covered by case A's same run. |
| E: flag off | Hits the exact pre-existing V1 guard (`"GOOGLE_AI_API_KEY not provided"`), proving V1's path is untouched; webhook body carries zero V2 fields. |

Full captured webhook body for case A:
```
performanceErrorAssessment = {"status": "unavailable", "reason": "no validated performance-error detector exists for this pipeline; alignment succeeded but that is evidence of alignment quality, not of correct playing"}
scoreCompleteness = {"pages_total": 1, "pages_processed": 1, "partial_error": null, "coverage_fraction": null, "coverage_source": "unavailable - no verified reference for a real upload", "status": "complete (single page, no partial-read signal) - not independently verified"}
alignmentStatus = "accepted"
meterDependentClaimsAvailable = false
flags = []
pipelineDebug:
  analysis_v2: enabled
  v2_download: video=53,273,146B score=231,249B
  v2_page_omr: measures=48 time_signature=None error=None
  v2_note_array: 196 notes
  v2_basic_pitch: onset matrix=(25972, 88)
  v2_alignment: status=accepted aligned_rate=0.81 null_rate=0.19
```

## Task 4 — the live canary: STOPPED, before any spend

The directive requires explicit supervisor approval of a $0.05 cap before
any billable Modal/LLM request, and separately requires confirming the
staging endpoint/flag are isolated from production before running anything.

**Isolation is real and already exists**, confirmed by reading
`agent_workspace/PAGE_OMR_STAGING_DEPLOYED.md` (2026-10-31): a genuinely
separate Modal environment (`modal environment create staging`), deployed
under its own app name (`mediant-worker-staging`, `modal deploy -e staging
--name mediant-worker-staging`), reachable only via an authenticated
`modal.Function.from_name(..., environment_name="staging")` call — not a
public URL — confirmed distinct from production's `main` environment /
`mediant-worker` app before and after that prior deployment.

**But that staging deployment currently only exposes `staging_score_page_omr`
(a zero-credential page-omr-only verification hook) — not `analyze_async`/
`run_full_analysis`.** Running this round's 3 canary requests against the
real staging endpoint would require (a) redeploying `worker.py` to that
environment with this round's flag included, and (b) first rebuilding its
image to add `partitura`/`parangonar`, and separately solving Basic Pitch's
non-portable execution model (see "Real gap found" above) — the second of
which is a substantial rewrite, not a config change.

**Decision: do not deploy or spend anything without explicit direction.**
This is independent of the $0.05 question — even with budget approved, a
live call today would either crash on a missing import (if deployed without
first fixing the gap) or, if `_run_analysis_v2`'s defensive guards are
deployed as-is, immediately report `"unavailable"` for a trivial reason
(missing Basic Pitch) rather than exercising anything the canary is meant
to test. Spending the budget on that would prove nothing.

**No `modal deploy` was run. No billable request was made.** Tasks 1-3 are
complete, committed, and fully verified against local fixtures at $0.

## Regression

`cd modal_worker && pytest --continue-on-collection-errors -q`:
**299 passed -> 303 passed** (+4 new, in `test_analysis_v2.py`). Same 5
pre-existing failures (`test_visual_validation.py`) and 1 pre-existing
collection error (`test_generate_timing_accurate_reference_audio.py`) as
every prior round this week. `src/`, `page_omr_adapter.py`, and
`build_visual_validation_corpus.py` untouched.

## Files

- `modal_worker/worker.py` — `MEDIANT_ANALYSIS_V2_ENABLED` flag, `_run_analysis_v2`.
- `modal_worker/test_analysis_v2.py` — new, 4 tests, subprocess-isolated.
- `agent_workspace/LIMITED_STAGING_CANARY_2026-11-08.md` — this doc.
- `agent_workspace/AGENT_TASKS.md`, `agent_workspace/AUDIO_PIPELINE_AUDIT.md`,
  `agent_workspace/CHANGELOG.md` — log entries.
