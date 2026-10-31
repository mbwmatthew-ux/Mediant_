# page-omr + deskew: staging integration (not production)

2026-10-31. Per the owner's "MEDIANT — Integrate page-omr + Deskew Into
Staging" directive. Builds a real backend adapter and a staging-only
feature flag inside the actual Modal worker codebase — not another
isolated-script benchmark. No `modal deploy` was run; no live traffic was
touched; nothing changes for the existing production path.

## 1. Overall Mediant launch status

Unchanged. This is engineering groundwork (a selectable alternate
score-reading path, dormant by default) — it does not itself move the
product closer to or further from launch; see Section 7 for the actual
go/no-go read.

## 2. Files and functionality changed

- **New: `modal_worker/page_omr_adapter.py`.** The production adapter:
  deskew (frozen, ported unchanged from the validated scratchpad) →
  page-omr CPU inference (greedy decoding, same defaults the benchmark
  used, confirmed by inspecting the exact subprocess invocation the
  benchmark scripts made) → kern parsing into Mediant's canonical
  `{pitch, is_rest, beat, duration_beats}` measure shape (already
  identical to what `parse_musicxml`/`read_score_notes_claude` emit — no
  translation layer needed) → structured error/partial_error reporting.
  Multi-page continuity is simple sequential concatenation (no privileged
  ground-truth page mapping — production has none; see Section 4).
- **Modified: `modal_worker/worker.py`:**
  - Image: pins `transformers==4.46.3` (prevents the `Dinov2Model`
    collapse bug found in the first benchmark round) and installs
    page-omr from GitHub pinned to commit `e369a44a8232ddcf0ddd915f7e07b19cdcb91b61`
    — the exact commit every validation number in `PAGE_OMR_*.md` was
    produced against. `add_local_python_source("page_omr_adapter")` makes
    the new sibling module importable (this Modal client version does not
    auto-mount sibling files).
  - `_score_pipeline()` (inside `run_full_analysis`): a new
    `MEDIANT_SCORE_ENGINE` env var (not a request/payload field — the
    frontend API contract is unchanged) selects `page_omr` vs. the
    default, unset Claude+Audiveris path. Unset/any-other-value is
    byte-for-byte the old code path — zero added cost, zero behavior
    change, confirmed by the full existing test suite staying green.
  - Score-cache short-circuit now checks `score_cache_matches_engine()`
    before trusting a cache hit — `score_cache` is keyed only by the
    photo's content hash, shared across whichever engine last wrote it,
    so without this a flag flip could silently serve the other engine's
    stale result. A mismatch re-downloads and re-reads fresh.
  - Score-DTW eligibility (`is_vision_sourced_score()`, extracted as a
    named, tested function) now also matches `source == "page_omr"` —
    without this, every page-omr-sourced take would have silently
    regressed to the far less accurate beat-grid alignment, with no
    error, defeating the point of comparing the two engines.
  - The reference-audio provenance gate (refuses to synthesize audio from
    a marker-less vision-sourced fallback score) now also covers
    `"page_omr"` for the same reason — page-omr has a real, measured
    error rate, not a deterministic parse, so it belongs in the same risk
    class as Claude vision, not music21's.
  - Both of the above reuse the same new `is_vision_sourced_score()`
    helper rather than duplicating the string check — one extraction,
    two call sites, both independently unit-tested.
- **New test files:** `modal_worker/test_page_omr_adapter.py` (16 checks:
  the measure-renumbering fix against real music21 humdrum parsing,
  malformed-output handling, multi-page renumbering/concatenation,
  total-failure and partial-failure orchestration) and 3 new checks added
  to `modal_worker/test_analysis.py` (cache-engine-matching,
  vision-sourced-score classification, the reference-audio gate extended
  to page-omr).
- **No frontend changes.** No edge-function changes. No DB
  migration/schema change. No changes to CREPE, beat tracking, or Gemini
  coaching.

## 3. Integration test results

- **Existing suite**: `modal_worker/test_analysis.py` — 719/719 checks
  pass (707 pre-existing + 12 new), confirming the default path is
  provably unchanged.
- **New adapter unit tests**: `modal_worker/test_page_omr_adapter.py` —
  16/16 pass, run against real `music21` humdrum parsing (not mocked) for
  the canonicalization logic, with inference mocked for the orchestration
  logic (no real model in this dev environment — see below for where the
  real model WAS exercised).
- **Real inference through the actual production module** (isolated venv
  with the real checkpoint, calling `page_omr_adapter.py` exactly as
  `worker.py` would — not the old scratchpad script):
  - 2220 (Cello, single-page, mild): 100% pitch accuracy, 48/48 measures
    exact — **byte-for-byte identical** to the already-recorded
    deskewed-benchmark number for this piece (`deskew_full_scored.json`),
    confirming the production port reproduces validated behavior exactly,
    not just "looks right."
  - 2220 (clean tier): 100% pitch accuracy — matches expectation.
  - 2204 (Flute, single-page, mild): 100% pitch accuracy, 46/48 exact
    measures.
  - 2186 (Violin, 3-page, mild) — the one genuinely new code path (no
    privileged page mapping, unlike the benchmark): sequence-level
    (boundary-independent) pitch accuracy 98.6%, comparable to (not worse
    than) the benchmark's own privileged-mapping result for the same
    piece (97.8%). Per-measure accuracy was 77.4% vs. the benchmark's
    66.1% — also not worse. **This is one real multi-page data point, not
    a validated general claim** — production's simpler concatenation
    was not shown to regress multi-page handling here, but n=1.
  - Confirmed inference is deterministic through the real production
    entrypoint (two back-to-back calls on identical bytes produced
    byte-identical measures) — ruled out as an explanation before writing
    anything about it, since an earlier debug comparison across two
    different ad hoc scripts looked contradictory until traced to
    comparing non-corresponding text slices, not a real discrepancy.
  - Elapsed times matched the already-measured ~11-13s/page CPU cost
    (9.2s-39.7s for 1-3 page runs), consistent with the 109-page
    validation's own average.

## 4. Actual visual-reading accuracy and remaining limitations

Accuracy figures are unchanged from the already-validated benchmark
(clean 95.4%, mild 91.3% with deskew) — this round did not re-run the
full corpus, it verified the PRODUCTION CODE reproduces that benchmark
(Section 3) and extends to one new, previously-untested situation:

- **Multi-page continuity has no privileged mapping in production.**
  The benchmark always knew, from the piece's own real MusicXML via
  verovio, exactly which ground-truth measure numbers belonged on each
  page. Production has no such information — it only has the photographed
  pages. The adapter's approach is the simplest defensible one (read each
  page in upload order, renumber sequentially) and the one real spot-check
  (2186, above) did not show it underperforming the privileged-mapping
  benchmark — but this is one piece, not a validated claim, and no
  structural fix (e.g. detecting a plausible measure count per page) has
  been attempted.
- **One real smartphone photo was run (qualitatively, not scored)** — a
  pre-existing test fixture (`modal_worker/testdata/real_photo_sideways_
  exif_portrait.jpg`, a genuine iPhone photo of a clean clarinet part,
  EXIF-confirmed) used elsewhere only to test orientation normalization.
  It has no attached musical ground truth (consistent with the
  already-confirmed "zero clarinet/guitar ground truth" gap), so this is
  not an accuracy measurement. Qualitatively: ran successfully in 9.2s, 85
  measures, deterministic, no errors, output looks musically plausible
  (sustained notes, rests, scalar passages) on manual inspection — but
  "looks plausible" is not "verified correct," and this is the ONLY real
  (non-synthetic) photo tested anywhere in this entire investigation.
- **The ground-truth-free failure detector's unresolved generalization
  gap, named in the prior round, is unchanged** — the adapter uses only
  the repetition-collapse signal (validated: zero false positives across
  53 cases) to flag obviously-degenerate output, and explicitly does NOT
  use the character-length threshold the owner's root-cause directive
  rejected. This means a wrong-but-normal-looking page-omr transcription
  (the dominant failure shape found in the root-cause round) still has no
  automated flag in this adapter.

## 5. Modal hosting feasibility and cost

**Estimated from real measurements, not deployed to Modal** (no paid
compute was run — see constraints): freshly measured in this round, not
assumed:

- **Checkpoint load (warm, already cached locally)**: 3.5s. **Cold
  download** (737MB from the HF Hub) was not measured here — the
  recommended deployment approach is baking the checkpoint into the
  Modal image at build time (a `.run_commands` pre-download step, the
  same pattern Audiveris already uses in this file), which removes
  per-cold-start download time entirely rather than paying it on every
  container spin-up.
- **Peak memory**: 1.70GB RSS (184M params + PyTorch/transformers
  overhead), measured directly via `resource.getrusage`, not estimated.
- **Per-page latency**: ~11.4s inference + ~0.65s deskew (the already-
  measured 109-page average) — consistent with this round's fresh
  single/multi-page runs (9.2-13.2s/page).
- **CPU/GPU**: CPU-only; no GPU was used or requested anywhere in this
  investigation.
- **Cost** (Modal's current published Standard-tier rates, fetched
  directly from modal.com/pricing this round: $0.0000131/physical-core-
  second, $0.00000222/GiB-second): assuming a 2-core/4GiB container,
  ~12s/page costs **≈$0.0004/page** — for a typical 1-2 page score
  upload, on the order of a tenth of a cent. Concurrency: each request's
  pages could be dispatched in parallel the same way Audiveris rows
  already are (`.spawn()`); not implemented in this staging round since
  no load-testing was in scope.
- **Compared with the existing Claude multi-pass approach**: qualitatively
  much cheaper (page-omr's whole per-page cost is a fraction of a cent of
  CPU time; the existing path runs 2-3 Claude Sonnet 5 vision calls per
  score plus Audiveris subprocess calls per row). The EXACT dollar cost of
  the existing Claude path is not established anywhere in this codebase —
  a prior cost-redesign investigation (`docs/superpowers/specs/2026-10-28-
  visual-pipeline-cost-redesign-design.md`) explicitly names this as
  unmeasured. This report does not fabricate that number; the comparison
  above is order-of-magnitude, not a precise delta.

## 6. Real-photo validation status

**One real smartphone photo was available and was run** (Section 4) —
qualitatively plausible, not scored (no ground truth exists for it).
**No other authentic phone-photo samples with independently verified
score ground truth exist anywhere in this project's accessible assets** —
confirmed again this round (same gap named in every prior round). This
is the single most important gap before any real accuracy claim about
production conditions can be made.

## 7. Critical blockers to production deployment

1. **Zero scored real-photo accuracy data.** Every accuracy number in
   this entire investigation (95.4% clean, 91.3% mild) is against
   synthetic degradation of digitally-rendered pages — now evidenced as a
   realistic proxy (root-cause round), but still not a real photo.
2. **No automated detector for "wrong but normal-looking" output.** The
   dominant real failure mode found in the root-cause round has no
   runtime signal in this adapter.
3. **Multi-page concatenation is unvalidated beyond one spot-check.**
4. **Zero clarinet/guitar coverage**, independent of page-omr itself.
5. **No GPU/scale/concurrency testing** — CPU-only, single-request
   measurements only.
6. **No actual Modal deployment was tested** — all cost/latency/memory
   figures in Section 5 are measured locally and estimated onto Modal's
   published rates, not confirmed against a real Modal container.

## 8. Go/no-go recommendation for a controlled rollout

**NO-GO for any controlled rollout to real users at this time.** The
engineering integration itself (adapter, feature flag, cache-identity
fix, DTW/reference-audio gate extensions) is complete, tested, and
default-safe — it is reasonable to continue developing against it in
staging. But Section 7's blockers, especially #1 (zero real-photo
accuracy data) and #2 (no wrong-but-plausible-output detector), are the
same kind of gap a controlled rollout exists to catch blind — shipping to
even a small real cohort before closing them would be testing in
production what this investigation was explicitly set up to test safely
beforehand. The next decision point, if this proceeds, is sourcing or
creating real-photo ground truth (even a handful of pieces) specifically
to close blocker #1 before any user-facing test.

No production deployment occurred. No live traffic was migrated. No new
OMR model, no fine-tuning, no paid API calls, no teacher features, no
CREPE/DTW/Gemini-coaching changes. Stopping here per the directive's
explicit instruction to request approval before deployment.
