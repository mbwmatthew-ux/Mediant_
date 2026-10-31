# page-omr private staging deployment — plan for approval (NOT executed)

2026-10-31. Per "MEDIANT — Close Flat OMR and Advance page-omr", Task 2.
Nothing in this document has been run. `modal deploy` was not invoked.
This is the plan + spending cap for approval before any of it happens.

## 0. Current state (verified, not assumed)

- `MEDIANT_SCORE_ENGINE=page_omr` is confirmed selectable in
  `modal_worker/worker.py`'s `_score_pipeline()` (line ~10159); unset
  (or any other value) is byte-for-byte the existing production path —
  confirmed again this round via the full `test_analysis.py` suite
  (719/719) and `test_page_omr_adapter.py` (16/16).
- Modal account state (read-only `modal environment list` / `modal app
  list`, no deploy run): exactly **one** environment exists (`main`) and
  exactly **one** deployed app (`mediant-worker`, the production
  worker). No staging environment exists yet.
- The function that would run page-omr inference in staging
  (`run_full_analysis`) is already decorated
  `@app.function(image=image, timeout=890, memory=4096)` in production
  — no explicit `cpu=` is set, so Modal provisions its own default for
  a memory-only request. For a staging measurement run I want a known,
  fixed CPU count instead of an implicit default (see Section 2).

## 1. Isolation — how production cannot be affected

**Mechanism: a separate Modal Environment, not a feature-flagged
redeploy of the same app.** Modal's own documentation describes
Environments as exactly this: "sub-divisions of workspaces... to
prevent overwriting production apps... any lookups performed from an
app in an environment will by default look for entities in the same
environment" (secrets included). Concretely:

- `modal environment create staging` — one-time, free, idempotent.
- `modal deploy -e staging --name mediant-worker-staging modal_worker/worker.py`
  — deploys the SAME code, unmodified, into a namespace that:
  - gets its **own distinct endpoint URL**, different from the
    production URL hardcoded nowhere except `deploy.sh`'s interactive
    prompt and the `MODAL_WORKER_URL` Supabase secret;
  - has its **own, separately-scoped secrets** — `MEDIANT_SCORE_ENGINE=
    page_omr` is set ONLY in the `staging` environment, so it cannot
    leak into or affect the `main` environment's production deployment
    under any circumstance (not "the flag defaults off", but "the flag
    does not exist in production's namespace at all").
- **Supabase is never touched.** The staging worker's endpoint is
  invoked directly (a standalone test script posting local benchmark
  images), never through `analyze-performance`/`analysis-webhook`. The
  production `MODAL_WORKER_URL` secret is never read or written by this
  plan — real user uploads, `score_cache`, `takes`, and billing are
  structurally unreachable from staging, not merely untouched by
  convention.
- **Billing isolation**: Modal bills the workspace as a whole, but
  staging's own containers are capped (Section 2) and torn down
  (Section 5) independently of production's. Production's existing
  `mediant-worker` app's resource limits are not edited by this plan.

## 2. CPU and memory configuration

Production's `run_full_analysis` runs at `memory=4096` (4GB — already
matches the container size this investigation's cost estimate assumed)
with no explicit `cpu=`. For staging specifically, I'd add an explicit,
measured allocation so latency numbers are attributable to a known
resource shape rather than an implicit default:

- `cpu=2.0, memory=4096` on the staging deployment's function
  (overridden only for the staging app — production's decorator is
  unmodified).
- `max_containers=2` — a hard ceiling on concurrent staging containers,
  so even a scripting mistake during testing cannot scale cost
  unboundedly. (Production's `run_full_analysis` has no such cap today;
  this is a staging-only addition, not a production change.)
- `min_containers=0` — no idle/keep-warm container, so staging costs
  $0 whenever it is not actively being tested.

## 3. Checkpoint storage and loading strategy

Two options, with a recommendation:

- **Option A (recommended): bake the checkpoint into the image at
  build time**, via a `.run_commands` pre-download step — the same
  pattern already used for Audiveris's binary in this same image.
  Removes per-cold-start download time entirely; the tradeoff is a
  larger image (+737MB) and a rebuild whenever the pinned checkpoint
  changes (it is already pinned to a specific HF revision + repo
  commit, so this is already a deliberate, infrequent event).
- **Option B: a Modal Volume** caching the downloaded checkpoint across
  container restarts without baking it into the image — avoids image
  bloat, but the FIRST container on a fresh Volume still pays the full
  download, and Volumes add their own small per-GB storage cost.
- **This plan proposes Option A** for staging, consistent with "prepare
  a deployment that... cannot unintentionally affect production" — a
  self-contained image has no shared state with anything else.

## 4. Cold-start and warm inference measurement (what staging would measure first)

Before any accuracy testing, the FIRST staging requests would measure,
not assume:
1. Cold container start → checkpoint-ready time (expected near-zero
   extra if Option A is used — the checkpoint is already in the image
   at container boot, not downloaded at request time).
2. First-request (cold) vs. subsequent-request (warm) inference
   latency on one known clean-tier page, repeated 3x each.
3. Peak memory under real request load (already measured locally at
   1.70GB RSS single-page — confirming this holds inside an actual
   Modal container, not just a local process, is the one number this
   plan cannot get without the real deployment).

## 5. Per-page latency and compute cost — estimate going in, to be confirmed by Section 4

Already measured locally against Modal's published rates (fetched
directly from modal.com/pricing): ~11.4s inference + 0.65s deskew per
page, ≈$0.0004/page on a 2-core/4GiB container. This plan does not
change that estimate — Section 4's job is to confirm or correct it
against a REAL Modal container, since "estimated from local CPU
numbers" was explicitly named as a remaining gap in the prior round's
report.

## 6. Rollback and cleanup procedure

Because staging is a fully separate environment/app rather than a flag
flip on the production app, "rollback" is simpler than a production
rollback would be — there is nothing to roll production back FROM:

- `modal app stop mediant-worker-staging` — stops the staging app;
  immediate, no effect on the production `mediant-worker` app (verified
  distinct app IDs once both exist).
- `modal environment delete staging` — removes the environment and its
  scoped secrets entirely once testing is done.
- No Supabase secret ever points at staging, so there is no production
  config to revert.

## 7. Expected spending cap for approval

A realistic initial staging validation run (confirming cold/warm
latency, then re-running a modest slice of the existing corpus — say
30-50 pages across clean/mild tiers and multiple instruments, reusing
images already in `visual_corpus/`, no new paid APIs) costs, at the
rates above, on the order of **$0.02-$0.05** in actual compute. I am
requesting approval for a **hard cap of $5** for this staging phase —
roughly 100x the realistic estimate — as a ceiling I will not cross
without stopping and asking again, not an expected spend. I'll check
actual Modal billing (`modal app logs`/dashboard) during the run and
stop early if anything trends outside the estimate.

## Not yet done

`modal environment create staging` has not been run. No deploy has
happened. No cost has been incurred. This section exists to make
explicit that everything above is a plan awaiting the owner's approval,
per the directive's explicit instruction.
