# Declared BPM — Design

**Date:** 2026-09-08
**Status:** approved, ready for implementation plan
**Part of:** two-part request (BPM requirement, then AI reference-audio + score-sync
highlighting — planned separately; see session notes)

---

## Goal

Every recording submission requires the student to state the tempo they intend to
play at ("declared BPM"), and the analysis worker uses it to (1) seed the beat
tracker so it stops guessing blind, and (2) tell the student how their actual tempo
compared to what they said they'd play — distinct from the existing comparison
against the sheet music's printed tempo marking, because a student may deliberately
practice the same piece slower than written, and may practice it at different
tempos across different sessions.

## Why this is safe to build the way `time_sig` already works

`analyze-performance` already has this exact shape for time signature: the student's
typed value **overrides** the sheet-music vision-read value, with the reasoning
spelled out in a comment — "the student is looking at the actual sheet music, so
their answer is the better prior" (`modal_worker/worker.py` around the `time_sig`
resolution block). Declared BPM follows the identical shape: a required form field,
threaded through the same dispatch payload, consumed by the worker.

The other grounding fact: `run_beat_tracking(wav_bytes, estimated_bpm=None)`
(worker.py:887) already accepts a tempo seed in its signature — `start_bpm =
estimated_bpm if estimated_bpm and 30 <= estimated_bpm <= 300 else 120.0` — but its
only call site on the main analysis path, `run_beat_tracking(wav_bytes)` at
worker.py:2448, never passes one. Every take today seeds librosa's beat tracker with
a blind 120 BPM guess, which is a documented source of octave-tempo errors (a slow
Adagio tracked at 2x, a fast Presto at 0.5x). This is not a hypothetical improvement;
it is an existing parameter with no live caller.

The worker also already has `check_tempo_vs_marking(fitted_bpm, marked_bpm)`
(worker.py:4018) comparing measured tempo against the sheet music's printed marking,
reported as fact rather than fault ("a student practising deliberately slowly has
made no mistake"), silent inside `_TEMPO_MARK_PCT = 15.0` percent. This is the
template for the new declared-vs-measured comparison.

---

## Part 1 — Frontend + persistence

**`src/components/NewRecordingModal.jsx`**

- New required numeric field, `declaredBpm`, presented next to the existing time
  signature field.
- Client-side validation: integer, 20–300 (matches the range `parse_marked_bpm`
  already validates on the worker side — reuse the same bound rather than inventing
  a second one).
- `readyToAnalyze` gates on `declaredBpm` being present and in range, the same way it
  already gates on `instrument.trim()`.
- Included in the take-row insert as `declared_bpm`.
- Included in the Modal dispatch payload (`supabase/functions/analyze-performance/index.ts`,
  the `JSON.stringify({...})` block around line 1364) as `declared_bpm`, immediately
  next to the existing `time_sig` field it mirrors.

**Migration:** `supabase/migrations/<date>_add_declared_bpm_to_takes.sql`

```sql
alter table takes add column declared_bpm numeric;
```

Nullable — old takes have no value, and the column stays nullable at the DB level
even though the frontend enforces "required" at submission time (same relationship
`time_sig` doesn't even have a column, but `declared_bpm` gets one deliberately: it's
information about *this specific take*, not a re-derivable property of the piece, and
you want it visible across sessions where the same piece was practiced at different
tempos).

**Why per-take, not per-song/per-piece:** confirmed directly — "when people work on
the same piece, they might want to work on it at different intervals and different
BPMs." A `user_pieces`-level default would contradict that.

---

## Part 2 — Worker integration

Both uses are additive: nothing on the existing path changes behavior when
`declared_bpm` is absent (reanalysis of an old take, or a take that went through the
inline fallback pipeline rather than Modal).

### 2a. Beat-tracker seed

`run_full_analysis` receives `declared_bpm` from the dispatch payload (new parameter,
alongside the existing `time_sig`). The `_crepe_pipeline` closure's call to
`run_beat_tracking(wav_bytes)` (worker.py:2448) becomes:

```python
beats = run_beat_tracking(wav_bytes, estimated_bpm=declared_bpm)
```

No change inside `run_beat_tracking` itself — its existing sanity clamp
(`30 <= estimated_bpm <= 300`) already handles an out-of-range or missing value by
falling back to the 120 BPM default.

### 2b. New coaching signal — declared vs. measured

New function, sibling to `check_tempo_vs_marking`:

```python
_TEMPO_DECLARED_PCT = 15.0   # same tolerance as the marked-tempo check

def check_tempo_vs_declared(fitted_bpm, declared_bpm) -> dict | None:
    """
    How the played tempo compares with what the student said they'd play.

    Same posture as check_tempo_vs_marking: reported as fact, not fault. A student
    who declared 80 and drifted to 95 made a tempo-stability observation available,
    not a mistake against the score. This is deliberately independent of
    check_tempo_vs_marking — both can fire on the same take (declared slower than
    marked, then played faster than declared, is two true, non-contradictory facts).
    """
    try:
        f = float(fitted_bpm or 0.0)
        d = float(declared_bpm or 0.0)
    except (TypeError, ValueError):
        return None
    if f <= 0 or d <= 0:
        return None
    pct = (f - d) / d * 100.0
    if abs(pct) < _TEMPO_DECLARED_PCT:
        return None
    return {"pct": round(abs(pct), 1),
            "direction": "faster" if pct > 0 else "slower",
            "fitted": round(f, 1), "declared": round(d, 1)}
```

Called alongside the existing `check_tempo_vs_marking` call (worker.py:5471), same
guard pattern, folded into coaching copy with its own sentence, e.g.:

> "You said you'd practice this at 80 BPM but drifted up to 95 BPM (+19%) — worth
> practicing with a metronome if you want to lock in the slower tempo."

Flag type: reuses the existing `"timing"` type, same as the marked-tempo comparison —
no new type added to the [[Flag Data Structure]] table.

### Edge cases

- **Missing `declared_bpm`** (old take reanalyzed, or inline-fallback pipeline, which
  does not have this level of tempo logic at all): every new code path guards on
  presence first, identical to how `check_tempo_vs_marking` already guards on
  `marked_bpm`. No exception, no flag, silent no-op.
- **Out-of-range or garbage input reaching the worker:** server-side re-validation to
  20–300 — never trust client validation alone. Reuses the same bound
  `parse_marked_bpm` already uses, so there is exactly one "valid BPM" definition in
  the worker, not two.

---

## Testing

- Worker unit tests (`modal_worker/test_analysis.py` or sibling): `check_tempo_vs_declared`
  — silent inside ±15%, correct direction/pct outside it, `None`/`0`/negative inputs
  return `None` without raising. Mirror the existing `check_tempo_vs_marking` test
  cases exactly, since the functions are siblings.
- `run_beat_tracking`: confirm `estimated_bpm` outside 30–300 falls back to 120
  (already covered by existing logic; add a case if none exists).
- Frontend: `readyToAnalyze` false when `declaredBpm` is empty or out of range; true
  once valid, matching how `instrument` is already tested/guarded.

## Out of scope

- Backfilling `declared_bpm` on existing takes.
- Any change to `check_tempo_vs_marking` or the marked-tempo comparison — they stay
  independent, both can fire.
- The AI reference-audio-generation and score-sync-highlighting feature — separate
  spec, to be brainstormed next.
