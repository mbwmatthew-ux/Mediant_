# page-omr — production-integration readiness audit (2026-10-31)

Per "MEDIANT — Finish Visual Integration and Improve Audio Accuracy",
Priority 1: "prepare the smallest safe path to production integration."
This is an audit + one real build-safety fix — no production deploy, no
production config change, no `modal deploy` to the `main` environment was
run.

## Current versions, verified directly (not assumed)

- **Frontend**: zero changes. `git diff --stat 0b7889d..HEAD -- src/
  supabase/` is empty — nothing in `src/` or `supabase/functions/` has
  been touched by any of the page-omr/Flat OMR work. Confirmed
  structurally, not just by diff: the frontend never talks to Modal
  directly — `NewRecordingModal.jsx`/`Analysis.jsx` POST to the
  `analyze-performance` **edge function**, which reads `MODAL_WORKER_URL`
  from Supabase secrets. Whichever score engine Modal uses internally is
  invisible to the frontend by construction.
- **Production Modal**: `mediant-worker` app in the `main` environment,
  last actually deployed at commit `0b7889d` (the compound-meter
  score-reading fix, 2026-10-30 — confirmed via `modal app list` showing
  one deployed app, cross-referenced against CHANGELOG's `modal deploy`
  entries). Two commits have landed since (`bb52d45`, `090cdf1`) that are
  **not yet deployed to production** — production is currently running
  the pre-page-omr image, unaffected by any of this work until someone
  explicitly runs `modal deploy modal_worker/worker.py` against `main`.
- **Staging**: `mediant-worker-staging` in the separate `staging`
  environment, deployed and verified (`PAGE_OMR_STAGING_DEPLOYED.md`).

## Real safety gap found and fixed this round

`worker.py`'s Modal image build had two kinds of gating that looked
parallel but weren't: the **runtime** engine flag (`MEDIANT_SCORE_ENGINE`,
baked via `.env(...)`) was already conditional on
`MEDIANT_BUILD_SCORE_ENGINE`, but the **build steps** needed to make
page-omr runnable at all — installing `git`, `pip install git+...page-omr`,
force-reinstalling `torchvision`, pinning `transformers==4.46.3`, and
baking the 737MB checkpoint — were unconditional. They ran for every
image build, including production's.

Concretely: the next ordinary `modal deploy` to production — for any
unrelated hotfix, with nobody thinking about page-omr at all — would have
silently grown production's image by page-omr's full dependency chain and
checkpoint, for a runtime path that image would still never execute
(`MEDIANT_SCORE_ENGINE` would stay unset). That's a real, avoidable
regression in production build time/image size/dependency-resolution
surface for zero benefit.

**Fix**: moved `git` and the entire page-omr `run_commands` block inside
the same `if _STAGING_BUILD_SCORE_ENGINE:` conditional that already gated
the `.env(...)` call, preserving the exact ordering already proven to
work on staging (page-omr install → torchvision force-reinstall →
transformers pin → checkpoint bake → `.env(...)`, all before
`.add_local_python_source`, since Modal refuses a build step after a
local-file add). A default production build is now unaffected by any of
this — confirmed by inspection (no code path reaches page-omr's build
steps unless `MEDIANT_BUILD_SCORE_ENGINE` is set in the shell issuing
`modal deploy`, which `deploy.sh` never does) and by the full regression
suite staying green (719/719 `test_analysis.py`, 16/16
`test_page_omr_adapter.py`) — this is a build-script reordering, not a
runtime logic change, so the existing tests (which never invoke Modal's
image builder) can't directly exercise it, but they do confirm zero
behavioral regression to anything they do cover.

## What was already true (confirmed, not re-built)

- **Score caching**: `score_cache_matches_engine()` (shipped in the
  staging-integration round) checks a cached row's `source` field against
  the currently-selected engine before trusting a cache hit — a
  cross-engine collision (serving a page-omr-sourced cache row to the
  Claude-vision path, or vice versa) is structurally prevented, not just
  unlikely.
- **Multi-page handling**: `score_pages_with_page_omr` concatenates pages
  with sequential measure renumbering — no privileged ground-truth
  mapping (production has none for either engine). Spot-checked on one
  real 3-page piece previously; this remains a known, disclosed
  limitation, not a regression.
- **Canonical representation**: `page_omr_adapter.kern_to_measures`
  produces the exact same `{"number", "notes": [{"pitch", "is_rest",
  "beat", "duration_beats"}]}` shape as `parse_musicxml` and
  `read_score_notes_claude` — confirmed identical in the staging-
  integration round, unchanged since.
- **Feature-flag control**: `MEDIANT_SCORE_ENGINE` (runtime,
  `_score_pipeline`) selects the engine; `MEDIANT_BUILD_SCORE_ENGINE`
  (build-time, local shell only) controls whether that flag is even
  baked into the image. Default (both unset) is byte-for-byte the
  original Claude+Audiveris path — the single regression test suite
  (719/719) is the standing proof this hasn't drifted.

## Remaining safety checks before any real rollout decision

Unchanged from the last staging round, restated here as the actual
checklist for "controlled deployment," not a new investigation:

1. **Zero scored real-photo accuracy data.** The central blocker — every
   number so far is on synthetic degradation or clean renders, not real
   camera photos with independently verified ground truth.
2. **No detector for wrong-but-normal-looking output.** page-omr can
   produce a plausible-looking but incorrect transcription with no
   internal signal distinguishing it from a correct one, beyond the
   validated (but narrow) `collapse_ratio` repetition-loop check.
3. **Zero clarinet/guitar ground truth** anywhere in this project.
4. **Modal per-Environment spend cap is dashboard-only** — if `staging`
   (or, later, a real production rollout) is ever meant to be hard-capped
   against runaway spend, that has to be set by the owner in the Modal
   dashboard; there is no CLI/API for it.
5. **No rollback telemetry.** If page-omr were ever flipped on for real
   traffic, there is currently no dashboard/alert distinguishing "engine X
   is producing bad output" from silence — the only signal today is a
   human noticing.

None of these are new; this round's contribution is closing the one gap
that was a real, concrete engineering risk (production build-time
contamination) rather than a data/evaluation gap, which Priority 1
explicitly said was in scope ("identify any remaining safety checks")
rather than "go collect the missing data" (that's Task 3-equivalent work,
out of scope here and already called out above).

**No production deployment or configuration change was made.** Production
(`main` environment) was not redeployed; this fix only changes what a
*future* production deploy would build.
