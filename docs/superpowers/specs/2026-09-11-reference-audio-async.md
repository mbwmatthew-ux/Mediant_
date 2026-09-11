# Reference Audio: Async Generation Design

**Status:** Approved by user, pending spec review.

## Problem

Tonight's accuracy fix for AI reference audio (`feat(worker): split dense
score pages into per-system row crops before vision reading`, commit
`24fea02`) splits a photographed sheet-music page into several row crops
before sending it to Claude, because sending a whole dense page as one
image produced an unreliable, partly-hallucinated transcription (verified
live: the same measure numbered differently between separate calls on an
identical photo, and measures several bars apart coming back as exact
mirror images of each other).

That fix works — verified against the real page that started this
investigation, producing 12 clean, correctly-bounded crops — but it makes
the underlying Claude vision call slower (12 images instead of 1). A live
test after raising the Modal function's own timeout to 280s and the edge
function's `AbortSignal` to 300s still failed:

```
{"code":"WORKER_RESOURCE_LIMIT","message":"Function failed due to not
having enough compute resources (please check logs)"}
```

This is Supabase Edge Functions' hard wall-clock execution limit — already
documented in this project's own Gotchas file ("Supabase Edge Function
150s wallclock limit... Always use `EdgeRuntime.waitUntil()` + webhook
pattern for analysis. Never do heavy inline work in the main request
handler."). No client-side timeout value can wait past it; the platform
kills the function regardless.

The `generate-reference-audio` edge function currently calls Modal
synchronously and waits for the full response — viable when the original
plan (`docs/superpowers/plans/2026-09-08-reference-audio.md`) reasoned the
Modal work was "pure CPU DSP rendering, fast enough for direct
request/response." That assumption no longer holds now that fixing the
actual accuracy problem requires a slower, multi-image vision call.

## Goal

Convert reference-audio generation from synchronous request/response to
asynchronous spawn + webhook + poll — mirroring the **existing, already-
working** pattern this exact codebase uses for the main analysis pipeline
(`analyze_async` → `run_full_analysis.spawn()` → `analysis-webhook` →
frontend polls `job-status`). This is adaptation of a proven pattern, not
new architecture.

## Non-goals

- No change to *what* gets generated or *how* the score gets read (the
  row-splitting fix, `split_page_into_rows`, `read_score_notes_claude`,
  `generate_reference_audio` synthesis) — all of that is already correct
  and unchanged by this spec.
- No change to the main analysis pipeline's own async flow — this spec
  only touches reference-audio's parallel, independent job state.
- No new Supabase secret — the existing `MODAL_WEBHOOK_SECRET` (already
  configured, already used by `analysis-webhook`) is reused as-is.

## Architecture

Five pieces change or get added, each mirroring one existing counterpart:

| New/changed piece | Existing pattern it mirrors |
|---|---|
| `takes.reference_audio_job_status` / `_job_error` / `_job_started_at` (migration) | `takes.job_status` / `job_error` / `job_started_at` |
| `generate_reference_audio_async` (new, lightweight Modal endpoint) | `analyze_async` |
| `generate_reference_audio_background` (new Modal function, `.spawn()`-invoked) | `run_full_analysis` |
| `generate-reference-audio-webhook` (new edge function) | `analysis-webhook` |
| `generate-reference-audio` (edge function, made idempotent/pollable) | `job-status` (read side) + `analyze-performance` (dispatch side), combined into one endpoint since reference-audio's "start a job" and "check status" requests are already both `{takeId}` POSTs to the same URL |

### Data flow

1. **Frontend** (`useReferenceAudio.js`) calls `generate-reference-audio`
   with `{takeId}`, same as today.
2. **Edge function**, in order:
   - Cache hit (`reference_audio_path` already set): sign and return
     `{status: 'done', audioUrl, timeline, bpm, measureRange}` — **exactly
     today's existing behavior**, unchanged.
   - Job already in flight (`reference_audio_job_status === 'processing'`
     and started less than 5 minutes ago — same self-heal window
     `job-status` already uses): return `{status: 'processing'}` without
     re-dispatching. If started more than 5 minutes ago, self-heal to
     `failed` (stuck job, matching `job-status`'s existing pattern) and
     fall through to the "start fresh" branch below.
   - Otherwise (never attempted, or self-healed from stuck): sign score
     URLs (**existing logic, unchanged**), set
     `reference_audio_job_status='processing'`,
     `reference_audio_job_started_at=now()`, call the new
     `generate_reference_audio_async` Modal endpoint (fast — it only
     kicks off a spawn) with the score URLs + webhook URL + webhook
     secret + instrument/bpm, and return `{status: 'processing'}`.
3. **Frontend** polls the same `generate-reference-audio` endpoint every 5
   seconds (matching `NewRecordingModal.jsx`'s existing interval), up to
   120 attempts (10 minutes, comfortably over the 6-minute floor the
   self-heal window requires), until it sees `done` or `failed`.
4. **Modal**, in the background: `generate_reference_audio_background`
   does the real work — download score pages, `read_score_notes_claude`
   (with row-splitting, unchanged from tonight's earlier fix),
   `generate_reference_audio` (MIDI+synthesis, unchanged), then calls the
   **existing** `post_webhook` helper with either
   `{takeId, audio_base64, timeline, bpm}` or `{takeId, error}`.
5. **Webhook edge function** (`generate-reference-audio-webhook`):
   validates `x-webhook-secret` against `MODAL_WEBHOOK_SECRET` (same
   secret, same header name, same check `analysis-webhook` already does),
   then either uploads the audio + writes `reference_audio_path`/`_bpm`/
   `_timeline`/`reference_audio_job_status='done'`, or writes
   `reference_audio_job_status='failed'` + `_job_error`.

### What moves, what doesn't

`_generate_reference_audio`'s current body (score-URL-or-fallback
resolution, the 500-measure cap, the bpm range check, calling
`generate_reference_audio`, base64-encoding the result) moves into
`generate_reference_audio_background` essentially unchanged — it's already
a plain, undecorated, testable function precisely because of last night's
"Modal decorators are mocked in tests" refactor, so this move doesn't
reintroduce that problem. `generate_reference_audio_async` is a new, thin
wrapper (mirrors `analyze_async`'s ~8 lines) that validates the request has
what it needs and calls `.spawn()`.

## Error handling

- **Spawn dispatch fails** (network error calling
  `generate_reference_audio_async`): edge function returns
  `{status: 'failed', error: ...}` immediately, same shape the frontend
  already handles for a synchronous failure today — no `job_status` row
  update needed since nothing was ever marked `processing`.
- **Background job throws before reaching the webhook call**: the
  existing `run_full_analysis` pattern wraps its whole body in
  `try/except` and posts `{takeId, error}` to the webhook on any
  exception — `generate_reference_audio_background` does the same, so a
  stuck-forever `processing` row only happens if the webhook POST itself
  fails, exactly the same residual risk `run_full_analysis` already
  carries and already has a stated mitigation for (the 5-minute self-heal
  in `job-status`, mirrored here).
- **Webhook POST fails to reach Supabase** (network partition, DNS,
  etc.): same residual risk as the main pipeline's webhook today — no new
  exposure introduced. The 5-minute self-heal is the existing, accepted
  mitigation.

## Testing

- **Worker**: `generate_reference_audio_async` gets the same treatment as
  `analyze_async` — no dedicated test (matches the existing convention
  that neither `analyze_async` nor `analyze` has one; correctness is
  structural — it validates input and spawns). `generate_reference_audio_background`
  reuses the exact test coverage `_generate_reference_audio` already has
  (the fresh-read-vs-fallback tests, the row-splitting tests) since its
  body doesn't change, only its trigger and end-of-function action
  (webhook POST instead of `return`) — those tests get renamed to target
  the new function name and gain one assertion each for the webhook call
  shape.
- **Edge functions**: `deno check` on both (existing convention — no unit
  test framework for edge functions in this repo, matches every other
  edge function here).
- **Manual end-to-end**: the exact live test that surfaced this problem —
  trigger generation on the real multi-page take, confirm the frontend
  shows a "Generating…" state that persists across polls rather than a
  single long-hanging request, confirm it completes with the same
  measureRange (m.12-67-ish) tonight's row-splitting fix already produced,
  confirm a cache-hit reload is still instant.

## Deployment

- Per the documented Gotcha ("Modal URL has no path — root only"), the new
  `generate_reference_audio_async` endpoint gets its own distinct URL,
  separate from every other Modal endpoint in this app. Capture it from
  the deploy output.
- Reuse the **existing** `MODAL_REFERENCE_AUDIO_URL` Supabase secret —
  update its *value* to the new async endpoint's URL rather than
  introducing a second secret name. Only one Modal URL is ever called from
  `generate-reference-audio` at a time; there's no reason to proliferate
  secret names for it.
- Apply the migration before redeploying `generate-reference-audio` and
  `generate-reference-audio-webhook` — both read/write the new columns
  unconditionally, matching the "migration before dependent code" ordering
  this project has already gotten wrong once tonight (the declared-BPM
  migration gap) and once before that (the reference-audio launch itself).
- The **old** synchronous `generate_reference_audio_endpoint` becomes dead
  code once the edge function stops calling it — delete it from
  `worker.py` in the same change that wires up the new async endpoint,
  rather than leaving an unused endpoint deployed and callable. Matches
  the documented Gotcha ("Dead code will make you describe the system
  wrongly") — an unused synchronous endpoint sitting next to a new async
  one is exactly the kind of thing a future reader could mistake for the
  live path.

## Migration

```sql
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_job_status TEXT;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_job_error TEXT;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_job_started_at TIMESTAMPTZ;
```

Purely additive, matches the exact `ADD COLUMN IF NOT EXISTS` shape every
other migration in this project already uses.
