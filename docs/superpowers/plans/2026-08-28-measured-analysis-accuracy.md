# Measured Analysis Accuracy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the measurement loop so analyzer accuracy becomes a number that can be tracked and improved, instead of a judgement nobody can check.

**Architecture:** The teacher-annotation path (`flag_annotations`) already captures ground truth but nothing reads it. This plan gives every flag a stable identity that survives re-analysis, persists the raw measurements behind each flag, and adds two offline tools — a replay harness that re-runs the flag logic over stored evidence without audio or API keys, and a scorer that reports precision/recall per flag type against teacher annotations. Phase 1 changes no thresholds; it makes threshold work possible.

**Tech Stack:** Python 3.11 (Modal worker, stdlib + numpy), Supabase Postgres migrations, Deno/TypeScript edge functions.

**Spec:** `docs/superpowers/plans/2026-08-28-measured-analysis-accuracy.md` (the "Terminal state" and "Program" sections below are the spec this plan implements). Supporting evidence: the per-detector accuracy report published 2026-08-28, and `Gotchas — Things That Will Bite You` in the Obsidian vault.

## Global Constraints

- Python target is 3.11; the Modal image pins `numpy>=1.24,<2.0`, `librosa==0.10.2`, `music21==9.1.0`, `torch<3.0`, `torchaudio<3.0`, `torchcrepe<1.0`. Do not add a dependency that forces numpy 2.x.
- `modal_worker/test_analysis.py` and `modal_worker/diagnose_coverage.py` must run with **no network, no API keys, no audio** — heavy imports are stubbed with `MagicMock`. Any new tooling must hold that property.
- Tests use the existing plain-assert + `check(name, ok, detail)` harness. Do not introduce pytest.
- All 174 existing unit checks and 28 coverage behaviours must still pass after every task.
- No flag may be shown to a student without a measure and a timestamp range (PD-005).
- Never widen what the analyzer claims in Phase 1. This phase is instrumentation only.
- Existing module-global evidence channels use the `_LAST_*` naming convention (`_LAST_TRANSPOSE_DEBUG`, `_LAST_DROPPED_UNCONFIRMED`). Follow it.

---

## Terminal state

"Perfect accuracy" is not a state this system can reach or verify. The achievable end state, and the one every task below serves:

1. **Precision is measured, not assumed.** For each flag type, the share of shipped flags a teacher approves is a tracked number over a labelled corpus.
2. **Recall is measured and deliberately chosen.** Teacher-added flags (`action='add'`) record what the analyzer missed. The team picks a recall target per type rather than discovering it by accident.
3. **Every flag is traceable.** Given any flag, the measurement, rule and threshold that produced it can be recovered from the database.
4. **Everything unverifiable is marked.** Categories with no corroborating detector (posture, technique, tone) are visibly distinguished from measured ones.
5. **Regression is impossible to ship silently.** A change that lowers precision on the corpus fails CI.

A category that cannot reach its precision target is *removed or marked unverified* — not shipped with a lower number. That is the existing product stance ("state it as fact or say nothing") applied to the analyzer itself.

---

## Program

Five phases. **Only Phase 1 is task-detailed in this document, deliberately** — see "Why phases 2-5 are not task-detailed yet" below.

| Phase | Goal | Exit criteria |
|---|---|---|
| **1. Instrument** | Make accuracy measurable | Replay + scorer run offline; baseline precision/recall published per flag type; CI fails on regression |
| **2. Calibrate** | Tune thresholds against the baseline | Every threshold in `worker.py` justified by a corpus measurement, not a guess |
| **3. Close the honest-silence gaps** | Stop shipping confident partial coverage | Multi-page, repeats, and polyphony each either analysed or explicitly declared out of scope in the UI |
| **4. Raise the floor** | Improve the weakest measured detectors | Each category at or above its chosen precision target, or marked unverified |
| **5. Extend** | New capability, measured from day one | OMR / K-weighting / CREPE-note segmentation / polyphony, each landed with corpus numbers |

### Why phases 2-5 are not task-detailed yet

Writing "change `_TIMING_PLACEMENT_MS` from 110 to 95" today would be inventing a number. This project has already paid for that once: the Gotchas file records the rhythm-corroboration threshold being rewritten three times, each attempt breaking the coverage matrix in a way the evidence did not predict, until it was reverted and documented rather than shipped half-understood. The conclusion recorded there — *"five verified fixes plus one honest 'needs real data' beats six where one is a guess"* — is the reason this plan stops where the data stops.

Phase 2 gets written as its own plan the day the Phase 1 baseline exists, because the baseline determines which thresholds are even worth touching.

---

## File Structure

**Created:**
- `supabase/migrations/20260829000001_add_flag_key_to_annotations.sql` — stable flag identity
- `supabase/migrations/20260829000002_create_analysis_evidence.sql` — raw measurement store
- `modal_worker/evidence.py` — builds the evidence bundle; pure, no I/O, testable
- `modal_worker/replay.py` — re-runs flag logic over a stored bundle, offline
- `modal_worker/score_against_annotations.py` — precision/recall vs teacher annotations
- `modal_worker/test_evidence.py` — tests for the three modules above
- `.github/workflows/analysis-ci.yml` — runs the suites on every push

**Modified:**
- `modal_worker/worker.py` — emit `flag_key` and `provenance` per flag; expose `_LAST_EVIDENCE`
- `supabase/functions/analysis-webhook/index.ts` — persist the evidence bundle
- `supabase/functions/annotate-flags/index.ts` — accept and store `flag_key`

`evidence.py` is separate from `worker.py` on purpose: `worker.py` is 5,843 lines and every new detector has made it harder to hold in context. Bundle-building is pure data transformation with no Modal or audio dependency, so it belongs in a file that imports nothing heavy and can be tested directly.

---

## Task 1: Give every flag an identity that survives re-analysis

`flag_annotations` is keyed `UNIQUE(take_id, teacher_id, flag_index)`, and `flag_index` is the flag's **position in the array**. Re-running analysis reorders flags, so every existing annotation silently re-points at a different flag. Any corpus harvested before this is fixed is corrupted, so this task comes first.

Flags are deduped to one per `(measure, type)` — except posture and technique, which collapse to one per type — so `type:measure` is almost unique within a take. "Almost" is not enough: the invariant pass at the end of `compare_and_coach_claude` can relabel a flag's measure, which can collide two same-type flags onto one key. The key therefore gets a collision suffix.

**Files:**
- Create: `supabase/migrations/20260829000001_add_flag_key_to_annotations.sql`
- Modify: `modal_worker/worker.py` (after the relabel pass, before `flags.sort`)
- Modify: `supabase/functions/annotate-flags/index.ts`
- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Produces: `assign_flag_keys(flags: list[dict]) -> None` — mutates in place, stamping `flag_key: str` on each flag. Format `"{type}:{measure}"`, with `"#2"`, `"#3"` … appended on collision, assigned in array order.
- Consumed by: Task 2 (`build_evidence_bundle` indexes provenance by `flag_key`), Task 5 (the scorer joins on it).

- [ ] **Step 1: Write the failing test**

Add to `modal_worker/test_analysis.py`, and register it in `main()` alongside the others:

```python
def test_flag_keys_are_stable_and_unique():
    print("\n[41] flags carry a stable, unique key")
    flags = [
        {"type": "intonation", "measure": 20},
        {"type": "timing",     "measure": 20},
        {"type": "intonation", "measure": 21},
    ]
    w.assign_flag_keys(flags)
    keys = [f["flag_key"] for f in flags]
    check("keys are unique", len(set(keys)) == 3, str(keys))
    check("key names the type and measure",
          keys[0] == "intonation:20" and keys[1] == "timing:20", str(keys))

    # Reordering the array must not change any flag's key — that is the whole
    # point: annotations survive a re-analysis that reorders flags.
    shuffled = [flags[2], flags[0], flags[1]]
    for f in shuffled:
        f.pop("flag_key")
    w.assign_flag_keys(shuffled)
    check("key is independent of array position",
          shuffled[1]["flag_key"] == "intonation:20", shuffled[1]["flag_key"])

    # A collision (two same-type flags relabelled onto one measure) must still
    # produce distinct keys rather than silently merging two annotations.
    collide = [{"type": "timing", "measure": 30}, {"type": "timing", "measure": 30}]
    w.assign_flag_keys(collide)
    check("collisions get distinct keys",
          collide[0]["flag_key"] != collide[1]["flag_key"],
          f'{collide[0]["flag_key"]} vs {collide[1]["flag_key"]}')
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `python3 modal_worker/test_analysis.py`
Expected: FAIL — `AttributeError: module 'worker' has no attribute 'assign_flag_keys'`

- [ ] **Step 3: Implement `assign_flag_keys`**

Add to `modal_worker/worker.py`, immediately above `def compare_and_coach_claude(`:

```python
def assign_flag_keys(flags: list[dict]) -> None:
    """
    Stamp a stable `flag_key` on each flag, in place.

    `flag_annotations` was keyed on flag_index — the flag's POSITION in the
    array. Re-running an analysis reorders flags, so every annotation then
    pointed at a different flag than the teacher looked at, silently corrupting
    the only ground truth this project has.

    Dedup guarantees one flag per (measure, type), so "type:measure" identifies
    a flag by what it SAYS rather than where it sits. The relabel pass can move
    a flag's measure after dedup, which can collide two same-type flags onto one
    key, so collisions take a suffix in array order.
    """
    seen: dict[str, int] = {}
    for f in flags:
        base = f"{f.get('type', 'issue')}:{f.get('measure', '?')}"
        n = seen.get(base, 0) + 1
        seen[base] = n
        f["flag_key"] = base if n == 1 else f"{base}#{n}"
```

- [ ] **Step 4: Call it in the pipeline**

In `compare_and_coach_claude`, immediately after the `_relabelled` invariant block and **before** `flags.sort(key=lambda x: x["measure"])`:

```python
    # Keys are assigned AFTER the relabel pass, so a key always names the
    # measure the Loop actually plays — the same measure the teacher saw.
    assign_flag_keys(flags)
```

- [ ] **Step 5: Run the full suite**

Run: `python3 modal_worker/test_analysis.py && python3 modal_worker/diagnose_coverage.py`
Expected: `178/178 checks passed` and `28/28 behaviours present`

- [ ] **Step 6: Add the migration**

Create `supabase/migrations/20260829000001_add_flag_key_to_annotations.sql`:

```sql
-- Stable per-flag identity for teacher annotations.
--
-- flag_index is the flag's POSITION in takes.flags. Re-running an analysis
-- reorders flags, so an annotation made before the re-run points at a different
-- flag afterwards — silently corrupting the ground truth these rows exist to be.
--
-- flag_key is derived from what the flag SAYS ("intonation:20"), assigned by
-- the worker after the measure-relabel pass, so it survives re-analysis.
-- flag_index is kept for backward compatibility with rows written before this.
ALTER TABLE public.flag_annotations ADD COLUMN IF NOT EXISTS flag_key TEXT;

CREATE INDEX IF NOT EXISTS idx_fa_flag_key ON public.flag_annotations(take_id, flag_key);

-- Teacher-added flags (action='add') have no AI original and so no key.
-- Everything else must be reachable by key once the worker is emitting them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_take_teacher_key
  ON public.flag_annotations(take_id, teacher_id, flag_key)
  WHERE flag_key IS NOT NULL;
```

- [ ] **Step 7: Store the key from the edge function**

In `supabase/functions/annotate-flags/index.ts`, add `flagKey` to the destructured request body and include it in the upsert payload:

```ts
        flag_index:       flagIndex ?? null,
        flag_key:         flagKey ?? null,
```

Leave the existing `onConflict: 'take_id,teacher_id,flag_index'` in place — rows written before this migration still need it, and the new unique index covers the keyed path.

- [ ] **Step 8: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py \
        supabase/migrations/20260829000001_add_flag_key_to_annotations.sql \
        supabase/functions/annotate-flags/index.ts
git commit -m "feat(analysis): stable flag_key so annotations survive re-analysis

flag_index is positional, so re-running an analysis silently re-pointed every
teacher annotation at a different flag. flag_key is derived from the flag's own
type and (post-relabel) measure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Record the measurement behind each flag

Today a flag carries `raw_detail` (a prose evidence string) but not the numbers. `timing_report["notes"]` — one row per note with `residual_ms` — is computed, read once for rhythm corroboration, and discarded. That is exactly the layer Phase 2 needs.

**Files:**
- Create: `modal_worker/evidence.py`
- Create: `modal_worker/test_evidence.py`
- Modify: `modal_worker/worker.py`

**Interfaces:**
- Consumes: `assign_flag_keys` from Task 1.
- Produces: `build_evidence_bundle(*, flags, timing_report, dynamics_report, wrong_note_candidates, crack_candidates, aligned, beats, score, alignment_method) -> dict` returning keys `version, flags, timing_notes, dynamics, candidates, alignment, score_parse`.
- Produces: module global `worker._LAST_EVIDENCE: dict` — set by `compare_and_coach_claude`, read by `run_full_analysis`. Same pattern as `_LAST_DROPPED_UNCONFIRMED`.

- [ ] **Step 1: Write the failing test**

Create `modal_worker/test_evidence.py`:

```python
"""Tests for the evidence bundle. No audio, no network, no API keys."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evidence import build_evidence_bundle

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))
    return ok


def test_bundle_is_json_safe_and_bounded():
    print("\n[1] bundle is JSON-serialisable and bounded")
    import json
    bundle = build_evidence_bundle(
        flags=[{"flag_key": "timing:20", "type": "timing", "measure": 20,
                "timing_deviation_ms": 130.0}],
        timing_report={"ok": True, "spb": 0.5, "bpm": 120.0, "n_notes": 40,
                       "placement": {20: {"median_ms": 130.0, "worst_ms": 150.0,
                                          "direction": "late", "n": 3}},
                       "drift": {}, "durations": {}, "overall": None,
                       "notes": [{"measure": 20, "beat": 1.0, "pitch": "C4",
                                  "time_sec": 1.0, "residual_ms": 130.0}] * 5000},
        dynamics_report={"ok": True, "levels": {"p": -30.1, "f": -18.4},
                         "spread_db": 11.7, "contrast": None, "inverted": []},
        wrong_note_candidates=[], crack_candidates=[],
        aligned=[{"time_sec": 1.0, "measure": 20, "score_idx": 3,
                  "cents_offset": 12, "confidence": 88}],
        beats={"tempo_bpm": 119.4, "beat_times": [0.0, 0.5, 1.0]},
        score={"source": "music21", "time_signature": "3/4",
               "measures": [{"number": 20, "notes": [{"pitch": "C4"}]}],
               "has_repeats": False},
        alignment_method="score_dtw",
    )
    raw = json.dumps(bundle)
    check("serialises", isinstance(raw, str))
    check("timing_notes capped", len(bundle["timing_notes"]) <= 2000,
          str(len(bundle["timing_notes"])))
    check("under 1 MB", len(raw) < 1_000_000, f"{len(raw):,} bytes")


def test_every_flag_gets_provenance():
    print("\n[2] every flag is traceable to a measurement")
    bundle = build_evidence_bundle(
        flags=[
            {"flag_key": "timing:20", "type": "timing", "measure": 20,
             "timing_deviation_ms": 130.0},
            {"flag_key": "posture:20", "type": "posture", "measure": 20},
        ],
        timing_report={"ok": True, "spb": 0.5, "bpm": 120.0, "n_notes": 40,
                       "placement": {20: {"median_ms": 130.0, "worst_ms": 150.0,
                                          "direction": "late", "n": 3}},
                       "drift": {}, "durations": {}, "overall": None, "notes": []},
        dynamics_report={"ok": False, "reason": "no markings"},
        wrong_note_candidates=[], crack_candidates=[], aligned=[],
        beats={"tempo_bpm": 120.0, "beat_times": []},
        score={"source": "music21", "measures": []}, alignment_method="score_dtw",
    )
    prov = {p["flag_key"]: p for p in bundle["flags"]}
    check("all flags present", len(prov) == 2, str(sorted(prov)))
    check("measured flag names its detector",
          prov["timing:20"]["detector"] == "analyze_timing_vs_score",
          prov["timing:20"]["detector"])
    check("measured flag carries the number",
          prov["timing:20"]["measured"] == 130.0, str(prov["timing:20"]["measured"]))
    # The honest half: an unverifiable flag must SAY it is unverifiable rather
    # than carry a blank that reads like a missing measurement.
    check("posture is marked unverifiable",
          prov["posture:20"]["evidence_class"] == "unverifiable",
          prov["posture:20"]["evidence_class"])


def main():
    test_bundle_is_json_safe_and_bounded()
    test_every_flag_gets_provenance()
    failed = [r for r in RESULTS if not r[1]]
    print("\n" + "=" * 70)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `python3 modal_worker/test_evidence.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'evidence'`

- [ ] **Step 3: Implement `evidence.py`**

Create `modal_worker/evidence.py`:

```python
"""
Raw measurement capture for the analysis pipeline.

Why this exists
---------------
Flags carry a prose evidence string but not the numbers behind it, and
`timing_report["notes"]` — one row per note, with the residual that decided
every timing flag — is computed, read once, and thrown away when the function
returns. So "was this flag right?" could be answered by a teacher but "what
measurement produced it?" could not be answered at all, which makes threshold
work guesswork.

This module is deliberately free of Modal, audio and network imports so it can
be tested directly and reused by the offline replay harness.
"""

BUNDLE_VERSION = 1

# Which detector owns each flag type, and whether that detector measures
# anything. "unverifiable" is not a hedge — it is the honest label for a
# category with no corroborating measurement, and Phase 4 uses it to decide what
# gets marked in the UI.
_DETECTOR_BY_TYPE = {
    "intonation": ("run_pitch_tracking",        "measured"),
    "timing":     ("analyze_timing_vs_score",   "measured"),
    "rhythm":     ("analyze_timing_vs_score",   "measured"),
    "error":      ("find_wrong_note_candidates", "measured"),
    "dynamics":   ("analyze_dynamics_vs_score", "measured"),
    "tone":       ("gemini",                    "unverifiable"),
    "posture":    ("gemini",                    "unverifiable"),
    "technique":  ("gemini",                    "unverifiable"),
}

_MAX_TIMING_NOTES = 2000
_MAX_EVENTS = 2000


def _provenance_for(flag: dict, timing_report, dynamics_report) -> dict:
    ftype = flag.get("type", "")
    detector, evidence_class = _DETECTOR_BY_TYPE.get(ftype, ("unknown", "unverifiable"))
    measure = flag.get("measure")

    measured = None
    rule = None
    if ftype in ("timing", "rhythm") and isinstance(timing_report, dict) and timing_report.get("ok"):
        for name in ("placement", "drift", "durations"):
            row = (timing_report.get(name) or {}).get(measure)
            if row:
                rule = name
                measured = (row.get("median_ms") if name == "placement"
                            else row.get("pct") if name == "drift"
                            else row.get("delta_ms"))
                break
    elif ftype == "intonation":
        rule = "cents_vs_tuning_centre"
        measured = flag.get("cents_deviation")
    elif ftype == "dynamics" and isinstance(dynamics_report, dict) and dynamics_report.get("ok"):
        rule = "contrast" if dynamics_report.get("contrast") else "inverted"
        measured = dynamics_report.get("spread_db")

    if measured is None:
        measured = flag.get("timing_deviation_ms")
    if measured is None:
        measured = flag.get("cents_deviation")

    return {
        "flag_key":       flag.get("flag_key"),
        "type":           ftype,
        "measure":        measure,
        "detector":       detector,
        "evidence_class": evidence_class,
        "rule":           rule,
        "measured":       measured,
        "confirmed":      bool(flag.get("confirmed")),
        "raw_detail":     str(flag.get("raw_detail") or "")[:400],
    }


def build_evidence_bundle(*, flags, timing_report, dynamics_report,
                          wrong_note_candidates, crack_candidates,
                          aligned, beats, score, alignment_method) -> dict:
    """
    Assemble everything needed to re-derive, audit or re-score this analysis.

    Bounded on purpose: this lands in a JSONB column on every take, and a long
    recording produces thousands of CREPE events. The caps keep a bundle well
    under a megabyte while preserving every per-note timing residual that
    threshold work actually reads.
    """
    tr = timing_report if isinstance(timing_report, dict) else {}
    dr = dynamics_report if isinstance(dynamics_report, dict) else {}

    timing_notes = [
        {"measure": r.get("measure"), "beat": r.get("beat"), "pitch": r.get("pitch"),
         "time_sec": round(float(r.get("time_sec") or 0.0), 3),
         "residual_ms": round(float(r.get("residual_ms") or 0.0), 1)}
        for r in (tr.get("notes") or [])[:_MAX_TIMING_NOTES]
    ]

    events = [
        {"t": round(float(e.get("time_sec") or 0.0), 3),
         "m": e.get("measure"),
         "si": e.get("score_idx"),
         "cents": e.get("cents_offset"),
         "spread": e.get("cents_spread"),
         "conf": e.get("confidence"),
         "db": e.get("db"),
         "held": e.get("held_sec")}
        for e in (aligned or [])[:_MAX_EVENTS]
    ]

    measures = score.get("measures") or []
    return {
        "version": BUNDLE_VERSION,
        "flags": [_provenance_for(f, tr, dr) for f in (flags or [])],
        "timing_notes": timing_notes,
        "timing_fit": {
            "ok": tr.get("ok", False),
            "reason": tr.get("reason"),
            "spb": tr.get("spb"),
            "bpm": tr.get("bpm"),
            "n_notes": tr.get("n_notes"),
        },
        "dynamics": {
            "ok": dr.get("ok", False),
            "reason": dr.get("reason"),
            "levels": dr.get("levels"),
            "spread_db": dr.get("spread_db"),
        },
        "candidates": {
            "wrong_notes": list(wrong_note_candidates or [])[:20],
            "cracks": list(crack_candidates or [])[:20],
        },
        "alignment": {
            "method": alignment_method,
            "n_events": len(aligned or []),
            "n_matched": sum(1 for e in (aligned or []) if e.get("score_idx") is not None),
            "tempo_bpm": (beats or {}).get("tempo_bpm"),
            "n_beats": len((beats or {}).get("beat_times") or []),
        },
        "score_parse": {
            "source": score.get("source"),
            "time_signature": score.get("time_signature"),
            "n_measures": len(measures),
            "n_notes": sum(len(m.get("notes") or []) for m in measures),
            "has_repeats": bool(score.get("has_repeats")),
        },
        "events": events,
    }
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `python3 modal_worker/test_evidence.py`
Expected: `7/7 checks passed`

- [ ] **Step 5: Wire it into the worker**

In `modal_worker/worker.py`, beside the existing globals at line ~3213:

```python
# Evidence bundle from the most recent compare_and_coach_claude call, read by
# run_full_analysis and posted to the webhook. Same channel pattern as
# _LAST_DROPPED_UNCONFIRMED above.
_LAST_EVIDENCE: dict = {}
```

In `compare_and_coach_claude`, immediately after `assign_flag_keys(flags)` from Task 1:

```python
    global _LAST_EVIDENCE
    try:
        from evidence import build_evidence_bundle
        _LAST_EVIDENCE = build_evidence_bundle(
            flags=flags, timing_report=timing_report,
            dynamics_report=dynamics_report,
            wrong_note_candidates=wrong_note_candidates,
            crack_candidates=crack_candidates,
            aligned=aligned, beats={"tempo_bpm": (tempo or {}).get("bpm"),
                                    "beat_times": beat_times or []},
            score=score, alignment_method="score_dtw" if dtw_verified else "beat_grid",
        )
    except Exception as e:                       # never fail an analysis over telemetry
        print(f"[compare_and_coach_claude] evidence bundle failed: {e}")
        _LAST_EVIDENCE = {"version": 0, "error": str(e)}
```

In `run_full_analysis`, add to the `post_webhook` payload:

```python
            "analysisEvidence":  _LAST_EVIDENCE or None,
```

- [ ] **Step 6: Confirm nothing regressed**

Run: `python3 modal_worker/test_analysis.py && python3 modal_worker/diagnose_coverage.py && python3 modal_worker/test_evidence.py`
Expected: `178/178`, `28/28`, `7/7`

- [ ] **Step 7: Commit**

```bash
git add modal_worker/evidence.py modal_worker/test_evidence.py modal_worker/worker.py
git commit -m "feat(analysis): capture the measurements behind every flag

timing_report[notes] carried a per-note residual for every note and was
discarded when the function returned. Threshold work needs exactly that layer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Persist the bundle

**Files:**
- Create: `supabase/migrations/20260829000002_create_analysis_evidence.sql`
- Modify: `supabase/functions/analysis-webhook/index.ts`

**Interfaces:**
- Consumes: `analysisEvidence` on the webhook payload (Task 2).
- Produces: table `analysis_evidence(take_id PK, bundle JSONB, version INT, created_at)`.

A separate table rather than a column on `takes`: `takes` is selected wholesale by the Analysis page ([Analysis.jsx:564](../../src/pages/Analysis.jsx#L564) lists its columns explicitly, but `useTakes` and several pages do not), and a ~500 KB bundle on every row would be dragged into the frontend on every list query.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260829000002_create_analysis_evidence.sql`:

```sql
-- Raw measurements behind each analysis, one row per take.
--
-- Deliberately NOT a column on `takes`: several pages select takes wholesale,
-- and a bundle is up to ~1 MB. Keeping it in its own table means the analysis
-- list queries are unaffected.
--
-- This is the input to threshold calibration. Joined against flag_annotations
-- (teacher ground truth) it answers "what measurement produced the flag the
-- teacher rejected?", which nothing could answer before.
CREATE TABLE IF NOT EXISTS public.analysis_evidence (
  take_id     UUID        PRIMARY KEY REFERENCES public.takes(id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL DEFAULT 1,
  bundle      JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Same posture as score_cache: a public-schema table with RLS disabled is fully
-- exposed through PostgREST to anyone holding the anon key. Enable RLS with no
-- write policy; the service role bypasses RLS and keeps working.
ALTER TABLE public.analysis_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analysis_evidence FROM anon, authenticated;

-- Students may read the evidence for their own takes; nobody may write it
-- through the public API.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'analysis_evidence' AND policyname = 'ae_owner_read'
  ) THEN
    CREATE POLICY "ae_owner_read" ON public.analysis_evidence FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.takes t
          WHERE t.id = analysis_evidence.take_id AND t.user_id = auth.uid()
        )
      );
  END IF;
END $$;
```

- [ ] **Step 2: Persist it in the webhook**

In `supabase/functions/analysis-webhook/index.ts`, add `analysisEvidence` to the destructured body and its type, then after the successful `takes` update:

```ts
  // Fire-and-forget: evidence is diagnostics, and losing it must never fail the
  // analysis the student is waiting for.
  if (analysisEvidence && typeof analysisEvidence === 'object') {
    admin.from('analysis_evidence')
      .upsert({
        take_id: takeId,
        version: Number((analysisEvidence as { version?: number }).version ?? 1),
        bundle:  analysisEvidence,
      }, { onConflict: 'take_id' })
      .then(() => console.log('[analysis-webhook] evidence stored for', takeId))
      .catch((e: Error) => console.warn('[analysis-webhook] evidence write failed:', e.message))
  }
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260829000002_create_analysis_evidence.sql \
        supabase/functions/analysis-webhook/index.ts
git commit -m "feat(analysis): persist the evidence bundle per take

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Offline replay harness

The highest-leverage tool in this plan. It re-runs flag construction over a stored bundle with no audio, no Modal and no API keys, so a threshold change can be evaluated against **real takes** in seconds instead of by re-running the pipeline and paying for it.

**Files:**
- Create: `modal_worker/replay.py`
- Test: `modal_worker/test_evidence.py`

**Interfaces:**
- Consumes: a bundle dict from `build_evidence_bundle` (Task 2).
- Produces: `replay_bundle(bundle: dict) -> list[dict]` returning flag dicts with `flag_key`, `type`, `measure`, and `measured`.

- [ ] **Step 1: Write the failing test**

Append to `modal_worker/test_evidence.py`, and add the call in `main()`:

```python
def test_replay_reproduces_the_recorded_flags():
    print("\n[3] replay reproduces flags from a bundle alone")
    from replay import replay_bundle
    bundle = {
        "version": 1,
        "flags": [
            {"flag_key": "timing:20", "type": "timing", "measure": 20,
             "detector": "analyze_timing_vs_score", "evidence_class": "measured",
             "rule": "placement", "measured": 130.0, "confirmed": True,
             "raw_detail": ""},
            {"flag_key": "intonation:21", "type": "intonation", "measure": 21,
             "detector": "run_pitch_tracking", "evidence_class": "measured",
             "rule": "cents_vs_tuning_centre", "measured": 18.0,
             "confirmed": True, "raw_detail": ""},
        ],
        "timing_notes": [], "timing_fit": {"ok": True},
        "dynamics": {"ok": False}, "candidates": {"wrong_notes": [], "cracks": []},
        "alignment": {"method": "score_dtw"}, "score_parse": {}, "events": [],
    }
    out = replay_bundle(bundle)
    check("returns one entry per flag", len(out) == 2, str(len(out)))
    check("keys round-trip",
          {f["flag_key"] for f in out} == {"timing:20", "intonation:21"},
          str(sorted(f["flag_key"] for f in out)))
    check("measurement round-trips",
          next(f for f in out if f["flag_key"] == "timing:20")["measured"] == 130.0)


def test_replay_applies_a_threshold_override():
    print("\n[4] replay can re-decide a flag at a new threshold")
    from replay import replay_bundle
    bundle = {
        "version": 1,
        "flags": [
            {"flag_key": "timing:20", "type": "timing", "measure": 20,
             "detector": "analyze_timing_vs_score", "evidence_class": "measured",
             "rule": "placement", "measured": 130.0, "confirmed": True,
             "raw_detail": ""},
        ],
        "timing_notes": [], "timing_fit": {"ok": True},
        "dynamics": {"ok": False}, "candidates": {"wrong_notes": [], "cracks": []},
        "alignment": {"method": "score_dtw"}, "score_parse": {}, "events": [],
    }
    # Raising the placement floor above the measured value must drop the flag.
    # This is the whole point of the harness: try a threshold, see what changes,
    # WITHOUT re-running CREPE or paying for an API call.
    kept = replay_bundle(bundle, thresholds={"placement_ms": 200.0})
    check("flag drops above the new floor", kept == [], str(kept))
    kept2 = replay_bundle(bundle, thresholds={"placement_ms": 100.0})
    check("flag survives below it", len(kept2) == 1, str(len(kept2)))
```

- [ ] **Step 2: Run and confirm it fails**

Run: `python3 modal_worker/test_evidence.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'replay'`

- [ ] **Step 3: Implement `replay.py`**

Create `modal_worker/replay.py`:

```python
"""
Re-decide flags from a stored evidence bundle, offline.

Why this exists
---------------
Changing a threshold in worker.py and finding out whether it helped used to
require re-running the whole pipeline — CREPE, Gemini, Claude — against real
recordings, which costs money, takes minutes per take, and is non-deterministic
on the LLM legs. So thresholds got changed on intuition. The Gotchas file
records one being rewritten three times before being reverted unshipped.

A bundle already contains every measurement that decided every flag. Replaying
it answers "what would this take have reported at threshold X?" in milliseconds,
deterministically, for as many takes as the corpus holds.

This is deliberately NOT a re-implementation of the detectors. It re-applies the
final numeric gate to an already-measured value. Anything that changes what gets
MEASURED (a new window, a different pitch model) needs a real re-run — replay
covers threshold work, which is the bulk of calibration.
"""

# Defaults mirror worker.py. Keep them in sync when a threshold moves; the test
# suite pins the ones that matter.
DEFAULT_THRESHOLDS = {
    "placement_ms":   110.0,   # _TIMING_PLACEMENT_MS
    "drift_pct":        7.0,   # _TIMING_DRIFT_PCT
    "duration_ms":    140.0,   # _TIMING_DUR_MIN_MS
    "cents":            8.0,   # cents_flag_threshold, tightest (unfretted strings)
    "dynamics_db":      3.0,   # _DYN_MIN_DB
}

_RULE_TO_THRESHOLD = {
    "placement":              "placement_ms",
    "drift":                  "drift_pct",
    "durations":              "duration_ms",
    "cents_vs_tuning_centre": "cents",
    "contrast":               "dynamics_db",
}


def replay_bundle(bundle: dict, thresholds: dict | None = None) -> list[dict]:
    """
    Return the flags this bundle would produce under `thresholds`.

    A flag whose rule has no numeric threshold (posture, technique, tone, wrong
    notes — all decided by gates that are not a single number) passes through
    unchanged. Filtering those on a threshold they do not have would silently
    delete whole categories from a calibration run.
    """
    t = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    out: list[dict] = []
    for f in bundle.get("flags", []):
        limit_name = _RULE_TO_THRESHOLD.get(f.get("rule") or "")
        measured = f.get("measured")
        if limit_name is not None and isinstance(measured, (int, float)):
            # "contrast" fires when the spread is BELOW the floor — every other
            # rule fires when the measurement is above it.
            fires = (abs(measured) <= t[limit_name] if f.get("rule") == "contrast"
                     else abs(measured) >= t[limit_name])
            if not fires:
                continue
        out.append(dict(f))
    return out
```

- [ ] **Step 4: Run and confirm it passes**

Run: `python3 modal_worker/test_evidence.py`
Expected: `12/12 checks passed`

- [ ] **Step 5: Commit**

```bash
git add modal_worker/replay.py modal_worker/test_evidence.py
git commit -m "feat(analysis): offline replay harness for threshold work

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Score the analyzer against teacher annotations

**Files:**
- Create: `modal_worker/score_against_annotations.py`
- Test: `modal_worker/test_evidence.py`

**Interfaces:**
- Consumes: `replay_bundle` (Task 4); annotation rows shaped like `flag_annotations`.
- Produces: `score_take(flags, annotations) -> dict` and `aggregate(results) -> dict`, both keyed by flag type with `tp, fp, fn, precision, recall`.

Definitions, fixed here so later phases cannot quietly move the goalposts:

- **True positive** — a shipped flag a teacher marked `approve` or `edit`. An edit means the finding was real and the wording was wrong; that is a writing problem, not a detection error.
- **False positive** — a shipped flag a teacher marked `reject`.
- **False negative** — a teacher `add` row, i.e. something real the analyzer never reported.
- **Unlabelled flags are excluded from both**, never counted as correct. Treating silence as approval is how a precision number flatters itself.

- [ ] **Step 1: Write the failing test**

Append to `modal_worker/test_evidence.py`, and call it from `main()`:

```python
def test_scoring_against_annotations():
    print("\n[5] precision and recall per flag type")
    from score_against_annotations import score_take, aggregate
    flags = [
        {"flag_key": "timing:20", "type": "timing"},
        {"flag_key": "timing:24", "type": "timing"},
        {"flag_key": "intonation:21", "type": "intonation"},
        {"flag_key": "posture:20", "type": "posture"},   # unlabelled
    ]
    annotations = [
        {"flag_key": "timing:20", "action": "approve"},
        {"flag_key": "timing:24", "action": "reject", "rejection_reason": "not_audible"},
        {"flag_key": "intonation:21", "action": "edit"},
        {"flag_key": None, "action": "add",
         "edited_flag": {"type": "dynamics", "measure": 30}},
    ]
    r = score_take(flags, annotations)
    check("approve counts as a hit", r["timing"]["tp"] == 1, str(r["timing"]))
    check("reject counts against us", r["timing"]["fp"] == 1, str(r["timing"]))
    check("edit counts as a hit", r["intonation"]["tp"] == 1, str(r["intonation"]))
    check("teacher-added is a miss", r["dynamics"]["fn"] == 1, str(r["dynamics"]))
    # An unlabelled flag must not be scored at all. Counting it as correct is
    # how a precision number flatters itself.
    check("unlabelled flag is not scored",
          "posture" not in r or r["posture"]["tp"] == 0, str(r.get("posture")))

    agg = aggregate([r])
    check("timing precision is 0.5", abs(agg["timing"]["precision"] - 0.5) < 1e-9,
          str(agg["timing"]["precision"]))
    check("dynamics recall is 0.0", agg["dynamics"]["recall"] == 0.0,
          str(agg["dynamics"]["recall"]))
```

- [ ] **Step 2: Run and confirm it fails**

Run: `python3 modal_worker/test_evidence.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'score_against_annotations'`

- [ ] **Step 3: Implement the scorer**

Create `modal_worker/score_against_annotations.py`:

```python
"""
Precision and recall per flag type, measured against teacher annotations.

`flag_annotations` has existed since 2026-06-30 and its own migration says
"These rows ARE the training data" — but nothing ever computed anything from
them. This is that computation.

Counting rules, fixed deliberately:
  approve / edit -> true positive. An edit means the finding was REAL and the
                    wording was wrong. That is a writing problem, and folding it
                    into the detection score would hide both.
  reject         -> false positive.
  add            -> false negative: something real that was never reported.
  unlabelled     -> excluded from both. Never counted as correct — treating
                    silence as approval is how a precision number flatters
                    itself, and most flags will be unlabelled early on.
"""

_EMPTY = {"tp": 0, "fp": 0, "fn": 0}


def score_take(flags: list[dict], annotations: list[dict]) -> dict:
    """Per-type tp/fp/fn for one take."""
    by_key = {a.get("flag_key"): a for a in annotations if a.get("flag_key")}
    type_of = {f.get("flag_key"): f.get("type", "unknown") for f in flags}
    out: dict[str, dict] = {}

    for f in flags:
        ann = by_key.get(f.get("flag_key"))
        if ann is None:
            continue                       # unlabelled — not evidence either way
        row = out.setdefault(type_of[f["flag_key"]], dict(_EMPTY))
        action = ann.get("action")
        if action in ("approve", "edit"):
            row["tp"] += 1
        elif action == "reject":
            row["fp"] += 1

    for a in annotations:
        if a.get("action") != "add":
            continue
        added = a.get("edited_flag") or {}
        row = out.setdefault(str(added.get("type") or "unknown"), dict(_EMPTY))
        row["fn"] += 1

    return out


def aggregate(per_take: list[dict]) -> dict:
    """Sum per-take counts and derive precision/recall per type."""
    totals: dict[str, dict] = {}
    for r in per_take:
        for ftype, row in r.items():
            acc = totals.setdefault(ftype, dict(_EMPTY))
            for k in ("tp", "fp", "fn"):
                acc[k] += row[k]

    for ftype, row in totals.items():
        shipped = row["tp"] + row["fp"]
        real    = row["tp"] + row["fn"]
        row["precision"] = (row["tp"] / shipped) if shipped else None
        row["recall"]    = (row["tp"] / real) if real else None
        row["n_labelled"] = shipped
    return totals


def format_report(totals: dict) -> str:
    """Fixed-width report, same shape as diagnose_coverage.py's matrix."""
    def pct(v):
        return "  n/a" if v is None else f"{v * 100:5.1f}%"

    lines = ["=" * 78,
             f"{'FLAG TYPE':<18}{'PRECISION':>11}{'RECALL':>10}"
             f"{'TP':>6}{'FP':>6}{'FN':>6}{'LABELLED':>11}",
             "=" * 78]
    for ftype in sorted(totals):
        r = totals[ftype]
        lines.append(f"{ftype:<18}{pct(r['precision']):>11}{pct(r['recall']):>10}"
                     f"{r['tp']:>6}{r['fp']:>6}{r['fn']:>6}{r['n_labelled']:>11}")
    lines.append("=" * 78)
    return "\n".join(lines)
```

- [ ] **Step 4: Run and confirm it passes**

Run: `python3 modal_worker/test_evidence.py`
Expected: `19/19 checks passed`

- [ ] **Step 5: Commit**

```bash
git add modal_worker/score_against_annotations.py modal_worker/test_evidence.py
git commit -m "feat(analysis): precision/recall against teacher annotations

flag_annotations has existed since June and its migration says the rows ARE the
training data. Nothing read them. This is that computation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Make CI enforce it

`npm run lint` currently reports 99 errors and nothing runs the worker suites on push. A red baseline is a broken smoke detector: `analysisQuality` sat in that pile flagged as unused for months, and that specific error meant "the honesty mechanism is not wired up."

**Files:**
- Create: `.github/workflows/analysis-ci.yml`

- [ ] **Step 1: Add the workflow**

Create `.github/workflows/analysis-ci.yml`:

```yaml
name: Analysis CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  worker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      # The suites stub every heavy import, so they need numpy and nothing else.
      - name: Install test dependencies
        run: pip install 'numpy>=1.24,<2.0'

      - name: Worker unit checks
        run: python3 modal_worker/test_analysis.py

      - name: Coverage behaviours
        run: python3 modal_worker/diagnose_coverage.py

      - name: Evidence, replay and scoring
        run: python3 modal_worker/test_evidence.py

      # Catches a syntax error in the 5,800-line worker before it reaches Modal,
      # where the only symptom is a failed deploy nobody is watching.
      - name: Byte-compile the worker
        run: python3 -m compileall -q modal_worker/

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - name: Build
        run: npm run build
      # Lint is NOT gated yet: the baseline is 99 errors, all pre-existing dead
      # variables. Gating today would block every PR on unrelated debt. The
      # count is printed so it is visible, and Phase 3 drops the gate in once
      # the baseline is clean.
      - name: Lint (report only)
        run: npm run lint || true
```

- [ ] **Step 2: Verify the workflow runs the same commands locally**

Run: `python3 modal_worker/test_analysis.py && python3 modal_worker/diagnose_coverage.py && python3 modal_worker/test_evidence.py && python3 -m compileall -q modal_worker/ && npm run build`
Expected: all pass, no output from `compileall`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/analysis-ci.yml
git commit -m "ci: run worker suites, coverage and build on every push

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Publish the baseline

**Files:**
- Create: `agent_workspace/ACCURACY_BASELINE.md`
- Modify: `agent_workspace/AGENT_TASKS.md`, `agent_workspace/CHANGELOG.md`

- [ ] **Step 1: Harvest whatever annotations exist**

Run against the project database (service role required — `flag_annotations` denies anon/authenticated writes and the `fa_service_read` policy exists for exactly this):

```sql
SELECT t.id, t.instrument, t.piece_title,
       jsonb_array_length(COALESCE(t.flags, '[]'::jsonb)) AS n_flags,
       COUNT(a.id) AS n_annotations,
       COUNT(*) FILTER (WHERE a.action = 'approve') AS approved,
       COUNT(*) FILTER (WHERE a.action = 'edit')    AS edited,
       COUNT(*) FILTER (WHERE a.action = 'reject')  AS rejected,
       COUNT(*) FILTER (WHERE a.action = 'add')     AS added
FROM takes t
LEFT JOIN flag_annotations a ON a.take_id = t.id
WHERE t.job_status = 'done'
GROUP BY t.id
ORDER BY n_annotations DESC;
```

- [ ] **Step 2: Write the baseline document**

Create `agent_workspace/ACCURACY_BASELINE.md` recording, per flag type: precision, recall, labelled count, and the chosen target. State the corpus size and date. **If the corpus is too small to produce a meaningful number, write that down as the finding** — "n=3, not measurable" is a real result and the honest starting point. Do not compute a precision figure from a handful of flags and present it as a baseline.

- [ ] **Step 3: Update the boards**

Move this plan's phase to `Completed` in `agent_workspace/AGENT_TASKS.md`, add a Phase 2 entry to `Backlog`, and append a CHANGELOG entry.

- [ ] **Step 4: Commit**

```bash
git add agent_workspace/ACCURACY_BASELINE.md agent_workspace/AGENT_TASKS.md agent_workspace/CHANGELOG.md
git commit -m "docs: publish the analysis accuracy baseline

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Phase 1 exit criteria

- [ ] Every flag carries a `flag_key` that survives re-analysis
- [ ] Every analysis writes an evidence bundle to `analysis_evidence`
- [ ] `replay.py` re-decides flags from a bundle with no audio, network or keys
- [ ] `score_against_annotations.py` produces per-type precision and recall
- [ ] CI runs all three suites plus the build on every push
- [ ] `ACCURACY_BASELINE.md` states the current numbers, or states honestly that the corpus is too small

**The gate into Phase 2 is the corpus, not the code.** Every task above can be finished in days; the baseline cannot be trusted until enough takes are teacher-annotated. That is calendar time, not effort, and it is the reason to start harvesting annotations now rather than after the tooling is perfect.

---

## Self-review

**Spec coverage.** Terminal-state items 1 and 2 (measured precision/recall) → Tasks 5, 7. Item 3 (traceability) → Tasks 1, 2, 3. Item 4 (unverifiable marked) → Task 2's `evidence_class`, which Phase 4 consumes; the *UI* half is explicitly Phase 4, not this plan. Item 5 (no silent regression) → Task 6. Phases 2-5 are program-level by design, with the reason stated.

**Placeholder scan.** No TBDs. Every code step carries real code. Task 7 Step 2 asks for judgement rather than fixed content, which is correct — the numbers do not exist yet, and inventing them is the failure this plan exists to prevent.

**Type consistency.** `flag_key: str` is produced by `assign_flag_keys` (Task 1) and consumed under the same name in `_provenance_for` (Task 2), `replay_bundle` (Task 4) and `score_take` (Task 5). `build_evidence_bundle` is keyword-only in its definition and every call site. `evidence_class` takes exactly `"measured"` or `"unverifiable"` in both producer and test. `replay_bundle(bundle, thresholds=None)` matches both test call forms.

**One known gap, stated rather than hidden:** `replay.py` re-applies numeric gates to already-measured values. It cannot evaluate a change to *how* something is measured (a new pitch model, a different window). Those need a real re-run. Replay covers threshold calibration, which is the bulk of Phase 2 but not all of it.
