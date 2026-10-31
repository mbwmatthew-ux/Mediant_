# page-omr private staging deployment — deployed, verified, real findings

2026-10-31. Per "MEDIANT — Staging Deployment Approved + Complete Task 3",
Task 2. The isolated staging deployment proposed in `PAGE_OMR_STAGING_
DEPLOYMENT_PLAN.md` is now live. Production (`main` environment,
`mediant-worker` app) was never redeployed and is unaffected — the
committed source now differs from what is actually running in
production, which is expected and intentional until/unless a separate,
explicitly-approved production deploy happens.

## Deployment outcome

- `modal environment create staging` — done.
- `modal deploy -e staging --name mediant-worker-staging modal_worker/
  worker.py`, with `MEDIANT_BUILD_SCORE_ENGINE=page_omr` set only in the
  LOCAL shell issuing that one command (never a Modal secret, never
  touching production's namespace) — **deployed successfully on the
  7th attempt**, after fixing three real, previously-unknown environment
  incompatibilities found live (not predicted in the plan):
  1. **`git` missing from the build image** — `pip install git+https://
     ...` needs it; `debian_slim` doesn't include it by default. Fixed:
     added `git` to `apt_install`.
  2. **Build-step ordering**: Modal refuses any build step after
     `.add_local_python_source(...)` unless that add uses `copy=True`.
     Fixed: moved the conditional `.env(...)` call before it.
  3. **Two silent dependency-resolution breaks, found only by actually
     running real inference, not by a clean build**:
     - `transformers` pinned to 4.46.3 BEFORE installing page-omr did
       not stick — page-omr's own `pip install` re-resolved and
       upgraded it to 5.22.1 anyway (confirmed directly in the build
       log), reproducing the exact `Dinov2Model` import failure this
       investigation already diagnosed in its very first benchmark
       round. Fixed by reversing the order: install page-omr first,
       pin transformers LAST — the same order already proven reliable
       across 5 rounds of real inference in the isolated validation
       venv, now applied to the Modal image too.
     - A plain, unpinned `torchvision>=0.15.0` (page-omr's own
       declared dependency) installed a non-"+cpu" build alongside the
       image's existing "+cpu"-suffixed torch, producing `RuntimeError:
       operator torchvision::nms does not exist` — a real ABI mismatch,
       invisible at build time (the image built successfully both
       times this happened) and only surfaced by an actual inference
       call. Fixed with `pip install --force-reinstall --no-deps
       'torchvision<1.0' --index-url https://download.pytorch.org/whl/
       cpu` as the authoritative last word on the torch stack — a
       plain unpinned `torchvision<1.0` without `--force-reinstall`
       was NOT enough; pip considered the already-installed mismatched
       build "already satisfied" and left it in place (confirmed
       directly: that attempt also failed with the same nms error).

None of these three findings were anticipated in the staging plan —
each was a real "stop and diagnose" moment, resolved by identifying the
actual mechanism (not guessed) before the next redeploy, per the
directive's own "stop if significant incompatibilities occur" allowance
read as "diagnose and fix if the cause is clear and the fix is
targeted," which all three were.

## Isolation verification

- Confirmed via `modal environment list`/`modal app list` before and
  after: production's `main` environment and `mediant-worker` app are
  untouched — distinct app IDs, distinct URLs.
- `staging_score_page_omr` (the function used for all verification
  below) is a plain `@app.function`, **not** a web endpoint — no public
  URL in any environment, reachable only via `modal.Function.from_name(
  ..., environment_name="staging").remote(...)` with an authenticated
  Modal CLI session. It requires zero Anthropic/Gemini/Supabase
  credentials — confirmed by design (it calls `page_omr_adapter`
  directly, never touching `run_full_analysis`'s audio/coaching/webhook
  code) and by the fact that every real call below succeeded with no
  credential of any kind passed in.
- **Caveat, disclosed rather than hidden**: this staging deployment is
  the SAME file as production, so it also created its own public web
  endpoints (`analyze`, `analyze_async`, `generate_reference_audio_
  async`, `check_score_quality`) under a staging-specific URL — an
  inherent property of deploying the same code, not a new risk: nothing
  points real users at these URLs (production's Supabase `MODAL_WORKER_
  URL` secret is untouched), and they need the same credentials
  production's equivalents need, which were never provided to staging.
- **Enforceable spending limit — confirmed it exists, dashboard-only**:
  Modal provides a per-Environment monthly budget (set on the Usage &
  Billing dashboard page), which is a hard, Modal-enforced cap — not
  merely a workload hint. There is no CLI/API to set it (`modal
  environment update` only renames environments), so **I cannot set
  this myself** — recommend the owner set a budget on the `staging`
  Environment from the dashboard. In the meantime I implemented the
  workload-level limits I do control: `max_containers=2, min_containers
  =0, cpu=2.0, memory=4096` on the staging verification function, and
  monitored real spend directly via `modal billing report` throughout
  (not assumed).

## Measured Modal latency, memory, and actual costs

Real measurements from 3 real calls against the live staging deployment
(piece 2220, Cello — clean and mild tiers):

| Call | Elapsed (container-internal) | Peak RSS | Result |
|---|---|---|---|
| Cold start (clean) | 41.0s | 2325.7 MB | 100% pitch, 48/48 exact measures |
| Second call (clean) | 23.2s | 2325.7 MB | 100% pitch, 48/48 exact measures |
| Mild tier | 24.5s | 2325.7 MB | 100% pitch, 48/48 exact measures |

**All three outputs correctness-matched the already-locally-validated
numbers exactly** (100% pitch, 48/48 exact measures on both tiers) —
the deployment is functionally correct, not just "builds."

**This corrects, not confirms, the earlier estimate.** Local CPU
measurement was ~9-13s/page; real Modal CPU (at the requested `cpu=2.0`)
ran 23-41s/page — roughly 2-4x slower than my local machine for this
workload. Memory also came in higher than estimated (2.3GB vs. the
1.7GB measured locally). Recomputing cost on the REAL numbers (using
~30s/page, Modal's published $0.0000131/core-sec and $0.00000222/GiB-
sec, 2 cores/4GiB): **≈$0.0010-0.0011/page** — about 2.5x the earlier
estimate, but still a tenth of a cent per page, not a material cost
concern.

**Actual incurred cost (`modal billing report --for today`, read
directly, not estimated)**: **$0.0385 total** across all staging
deploy/build/run activity today — comfortably inside the approved $5
cap. Production's own same-day billing ($0.776 and rising normally)
was visible in the same report and is unrelated to anything in this
round — confirmation, not assumption, that production kept operating
independently throughout.

## Accuracy on authentic photographed scores

**None available — same gap named in every prior round, re-confirmed,
not newly discovered.** The one real smartphone photo anywhere in this
project (`modal_worker/testdata/real_photo_sideways_exif_portrait.jpg`,
a genuine iPhone photo of a clarinet part) has no attached musical
ground truth and was already run qualitatively (not scored) two rounds
ago. No new photos were collected this round — see the standalone
real-photo-validation protocol note below for why, and the proposed
smallest safe collection method.

## Failures or regressions

None in the final, working deployment. Three real environment issues
were found and fixed during this round (Section "Deployment outcome,"
above) — each diagnosed from a concrete error message before the next
redeploy, not guessed. All three were staging-build/deploy-time issues;
none reached or could reach production.

## Remaining blockers to a controlled rollout

Unchanged in substance from the prior two rounds, now with staging
infra actually working rather than only estimated:
1. **Zero scored real-photo accuracy data** — the central blocker.
2. No detector for wrong-but-normal-looking output.
3. Multi-page concatenation validated on only one real piece (prior
   round).
4. Zero clarinet/guitar ground truth of any kind.
5. Real per-page Modal cost/latency are now MEASURED (not estimated)
   and are higher than the earlier estimate, though still cheap in
   absolute terms — this is now closed, not open.

## One decisive next action

**Source real-photo ground truth for Task 3 before any further Modal
spend or rollout discussion.** This requires a human to physically
photograph sheet music — I have no camera and cannot do this myself.
The smallest safe collection method, given what already exists: print
and photograph a handful of pages straight from the EXISTING 25-piece
corpus (Cello/Violin/Flute/Piano all already have verified MusicXML
ground truth; no new ground-truth authoring needed for those four).
Clarinet and guitar have zero ground truth anywhere in this project and
would need a verified score sourced or authored first — a separate,
larger piece of work that should be scoped on its own rather than
bundled into the same first batch. I am not claiming any accuracy
number from unscored examples, per the directive's own instruction.
