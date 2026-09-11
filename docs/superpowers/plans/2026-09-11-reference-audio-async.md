# Reference Audio Async Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert AI reference-audio generation from a synchronous request/response (which now exceeds Supabase Edge Functions' hard 150-second wall-clock limit, since a real accuracy fix made the underlying vision call slower) to asynchronous spawn + webhook + poll — mirroring the exact pattern this codebase already uses for the main analysis pipeline.

**Architecture:** A new thin Modal endpoint validates a request and spawns a new background Modal function, mirroring `analyze_async`/`run_full_analysis`. The background function does the existing generation work (unchanged) and POSTs its result to a new webhook edge function instead of returning it directly. The existing `generate-reference-audio` edge function becomes idempotent: same request, but now returns `processing`/`done`/`failed` instead of blocking until the work finishes. The frontend hook polls it.

**Tech Stack:** Python/Modal (worker.py), Deno edge functions, Supabase Postgres + Storage, React hook (`useReferenceAudio.js`).

**Spec:** `docs/superpowers/specs/2026-09-11-reference-audio-async.md`

## Global Constraints

- No new Supabase secret — reuse the existing `MODAL_WEBHOOK_SECRET` (already configured, already used by `analysis-webhook`) for the new webhook's auth.
- No change to *what* gets generated or *how* the score gets read — `split_page_into_rows`, `read_score_notes_claude`, `read_score_notes_for_reference_audio`, `generate_reference_audio` (synthesis) are all unchanged by this plan.
- The old synchronous `generate_reference_audio_endpoint` must be deleted once nothing calls it — not left deployed as dead code.
- The `MODAL_REFERENCE_AUDIO_URL` Supabase secret's *value* gets updated to the new async endpoint's URL — no new secret name introduced.
- Migration must be applied before the edge functions that read/write the new columns are deployed.
- Poll interval and attempt count: 5 seconds, 120 attempts (10 minutes), matching `NewRecordingModal.jsx`'s existing pattern exactly.
- Self-heal window: a `processing` job older than 5 minutes is treated as stuck and reset to `failed`, matching `job-status/index.ts`'s existing 5-minute window exactly.

---

### Task 1: Migration — reference-audio job status columns

**Files:**
- Create: `supabase/migrations/20260911000000_add_reference_audio_job_status.sql`

**Interfaces:**
- Produces: three new nullable columns on `takes` — `reference_audio_job_status TEXT`, `reference_audio_job_error TEXT`, `reference_audio_job_started_at TIMESTAMPTZ` — consumed by Task 3 (webhook edge function, writes them) and Task 4 (`generate-reference-audio` edge function, reads and writes them).

- [ ] **Step 1: Write the migration**

```sql
-- Job-status tracking for async reference-audio generation, mirroring the
-- existing takes.job_status/job_error/job_started_at columns used by the
-- main analysis pipeline. Needed because generating reference audio now
-- involves a multi-image Claude vision call (see split_page_into_rows,
-- 2026-09-10) slow enough to exceed Supabase Edge Functions' 150s
-- wall-clock limit if done synchronously — this pairs with converting
-- generate-reference-audio to spawn + webhook + poll.
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_job_status TEXT;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_job_error TEXT;
ALTER TABLE takes ADD COLUMN IF NOT EXISTS reference_audio_job_started_at TIMESTAMPTZ;
```

- [ ] **Step 2: Verify the migration file matches the project's existing style**

Compare against `supabase/migrations/20260908_add_declared_bpm_to_takes.sql` (the most recent bare `ADD COLUMN IF NOT EXISTS` migration). No automated test applies to a bare SQL file — verification is this direct comparison.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260911000000_add_reference_audio_job_status.sql
git commit -m "feat(db): add reference-audio job status columns"
```

---

### Task 2: Worker — async endpoint + background function, delete the old synchronous endpoint

**Files:**
- Modify: `modal_worker/worker.py` — as of this plan's writing, the region from `analyze_async` through the end of `generate_reference_audio_endpoint` reads exactly:

  ```python
  @app.function(image=image, timeout=30, min_containers=1)
  @modal.fastapi_endpoint(method="POST", docs=True)
  def analyze_async(body: dict) -> dict:
      """
      Validates payload, spawns run_full_analysis in the background, returns immediately.
      The Edge Function only needs to wait ~2s for this acknowledgement.
      """
      take_id   = body.get("take_id")
      video_url = body.get("video_url")
      if not take_id or not video_url:
          return {"error": "take_id and video_url are required"}
      run_full_analysis.spawn(body)
      print(f"[analyze_async] spawned analysis for take {take_id}")
      return {"queued": True, "take_id": take_id}


  # ── Reference-audio endpoint ────────────────────────────────────────────────
  # Synchronous — pure CPU synthesis, no ML model, fast enough for a direct
  # request/response instead of the async .spawn()+webhook pattern the main
  # analysis pipeline needs. Gets its OWN Modal URL (see Gotchas: "Modal URL
  # has no path — root only"), separate from MODAL_WORKER_URL.

  def _generate_reference_audio(body: dict) -> dict:
      """
      Plain, undecorated implementation — Modal's decorators (@app.function,
      @modal.fastapi_endpoint) are blanket-mocked in the local test harness,
      which turns a decorated function into an unrelated MagicMock and makes
      it untestable directly. generate_reference_audio_endpoint below is a
      thin wrapper so this real logic stays testable; deployment behavior is
      unchanged (same body in, same dict out).

      Accepts: instrument (declared instrument string), bpm (target tempo),
      and EITHER:
        - score_urls (preferred): signed URL(s) for the take's own score
          page(s). Triggers a fresh, unbiased vision read (see
          read_score_notes_for_reference_audio) rather than trusting the
          shared, possibly-partial score_cache. Needs anthropic_api_key for
          image/PDF scores.
        - score (fallback / legacy): a pre-parsed score dict, same shape as
          score_cache.parsed_notes. Used directly if score_urls is absent,
          or as a fallback if the fresh read from score_urls fails/returns
          nothing (better a possibly-partial result than a hard failure).
      Returns: { audio_base64, timeline } or { error }.
      """
      instrument = body.get("instrument", "")
      bpm = body.get("bpm")

      score = None
      score_urls = body.get("score_urls")
      if isinstance(score_urls, list) and score_urls:
          score = read_score_notes_for_reference_audio(
              score_urls, instrument, body.get("anthropic_api_key"))
          if not score.get("measures"):
              print(f"[_generate_reference_audio] fresh read empty/failed "
                    f"({score.get('error')}), trying fallback score")
          elif score["measures"]:
              for m in score["measures"][:6]:
                  pitches = [n.get("pitch") for n in m.get("notes", [])]
                  print(f"[_generate_reference_audio] measure={m.get('number')} pitches={pitches}")

      if not (isinstance(score, dict) and score.get("measures")):
          fallback = body.get("score")
          if isinstance(fallback, dict) and fallback.get("measures"):
              score = fallback

      if not isinstance(score, dict) or not score.get("measures"):
          return {"error": "score with at least one measure is required"}
      if len(score.get("measures", [])) > 500:
          return {"error": "score has too many measures for reference-audio generation (max 500)"}
      try:
          bpm_f = float(bpm)
      except (TypeError, ValueError):
          return {"error": "bpm must be a number"}
      if not (20 <= bpm_f <= 300):
          return {"error": "bpm must be between 20 and 300"}

      try:
          audio_bytes, timeline = generate_reference_audio(score, instrument, bpm_f)
      except Exception as e:
          print(f"[_generate_reference_audio] FAILED: {e}")
          return {"error": f"Reference audio generation failed: {e}"}

      import base64
      return {
          "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
          "timeline": timeline,
      }


  @app.function(image=image, timeout=280, memory=2048)
  @modal.fastapi_endpoint(method="POST", docs=True)
  def generate_reference_audio_endpoint(body: dict) -> dict:
      """Renders an AI reference performance for a whole score. See _generate_reference_audio."""
      return _generate_reference_audio(body)
  ```

  This task deletes `generate_reference_audio_endpoint` entirely (the last
  function above) and inserts two new functions directly after
  `_generate_reference_audio` ends (i.e. exactly where
  `generate_reference_audio_endpoint` currently sits). `_generate_reference_audio`
  itself is **not modified** — its existing tests
  (`test_reference_audio_endpoint_prefers_fresh_read_over_provided_score`,
  `test_reference_audio_endpoint_falls_back_when_fresh_read_fails`) stay
  valid unchanged, since they call `_generate_reference_audio` directly,
  not the deleted wrapper.

  If this exact text is not found verbatim when you reach this task, stop
  and report NEEDS_CONTEXT rather than guessing at a new location — the
  file has drifted from what this plan was written against.

- Test: `modal_worker/test_analysis.py`

**Interfaces:**
- Consumes: `_generate_reference_audio(body: dict) -> dict` (unchanged, already exists), `post_webhook(webhook_url: str, webhook_secret: str | None, payload: dict, anon_key: str | None = None) -> None` (unchanged, already exists at `modal_worker/worker.py:6472`, used the same way `run_full_analysis` already uses it).
- Produces: `generate_reference_audio_background(payload: dict) -> None` — a plain Modal function (not a `@modal.fastapi_endpoint`), invoked via `.spawn()`. Consumed by Task 2's own `generate_reference_audio_async` (below) and no one else. `generate_reference_audio_async(body: dict) -> dict` — a `@modal.fastapi_endpoint`, consumed by Task 4 (the edge function calls this URL instead of the old synchronous one). Its request shape is identical to what `generate-reference-audio/index.ts` already sends today (`score_urls`, `score`, `instrument`, `bpm`, `anthropic_api_key`) **plus** two new required fields: `take_id` (string) and `webhook_url` (string) — Task 4 must send both. Its response shape is `{"queued": True, "take_id": <str>}` on success or `{"error": <str>}` if `take_id` or `webhook_url` is missing — this exact shape is what Task 4 is written against.
- `generate_reference_audio_background`'s webhook POST body: on success, `{"takeId": <str>, "audio_base64": <str>, "timeline": [...], "bpm": <number>}`; on failure (either `_generate_reference_audio` returned an `{"error": ...}` dict, or raised), `{"takeId": <str>, "error": <str>}`. This exact shape is what Task 3's webhook edge function is written against — do not change field names without updating Task 3 to match.

- [ ] **Step 1: Write the failing tests**

Add these two test functions to `modal_worker/test_analysis.py`, directly after `test_reference_audio_endpoint_falls_back_when_fresh_read_fails` (the last of the three existing reference-audio endpoint tests — search for that exact function name to find the insertion point):

```python
def test_reference_audio_background_posts_success_to_webhook():
    print("\n[73] generate_reference_audio_background posts the audio result to the webhook, not a return value")
    import types, json as _json
    captured = {}

    class _FakeStream:
        def __init__(self, payload): self._payload = payload
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get_final_message(self):
            return types.SimpleNamespace(
                content=[types.SimpleNamespace(text=self._payload)], stop_reason="end_turn")

    class _FakeMessages:
        def stream(self, **kw):
            return _FakeStream(_json.dumps({
                "key_signature": None, "time_signature": "4/4", "tempo_marking": None,
                "measures": [{"number": 1, "pg": 1, "notes": [{"p": "C4", "b": 1.0, "d": 1.0}]}],
            }))

    class _FakeAnthropicClient:
        def __init__(self, **kw): self.messages = _FakeMessages()

    class _FakeHttpResp:
        content = b"\x89PNG fake"
        headers = {"content-type": "image/png"}
        def raise_for_status(self): pass

    class _FakeHttpClient:
        def __init__(self, **kw): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, **kw): return _FakeHttpResp()
        def post(self, url, **kw):
            captured["webhook_url"] = url
            captured["webhook_payload"] = kw.get("json")
            captured["webhook_headers"] = kw.get("headers")
            return types.SimpleNamespace(status_code=200, text="ok")

    _ac = sys.modules["anthropic"]
    _httpx = sys.modules["httpx"]
    _orig_ac, _orig_httpx = _ac.Anthropic, _httpx.Client
    _ac.Anthropic = _FakeAnthropicClient
    _httpx.Client = _FakeHttpClient
    try:
        w._generate_reference_audio_background({
            "take_id": "take-123",
            "webhook_url": "https://example.test/webhook",
            "webhook_secret": "shh",
            "score_urls": ["https://example.test/p1.png"],
            "instrument": "Clarinet (B♭)",
            "bpm": 100,
            "anthropic_api_key": "fake-key",
        })
    finally:
        _ac.Anthropic, _httpx.Client = _orig_ac, _orig_httpx

    check("posts to the exact webhook_url given", captured.get("webhook_url") == "https://example.test/webhook",
          str(captured.get("webhook_url")))
    check("includes the webhook secret header", captured.get("webhook_headers", {}).get("x-webhook-secret") == "shh",
          str(captured.get("webhook_headers")))
    payload = captured.get("webhook_payload") or {}
    check("webhook payload carries takeId", payload.get("takeId") == "take-123", str(payload))
    check("webhook payload carries audio_base64", "audio_base64" in payload, str(payload.keys()))
    check("webhook payload carries a non-empty timeline", len(payload.get("timeline") or []) == 1, str(payload.get("timeline")))
    check("webhook payload carries bpm", payload.get("bpm") == 100, str(payload.get("bpm")))
    check("no error key on a successful generation", "error" not in payload, str(payload.keys()))


def test_reference_audio_background_posts_failure_to_webhook():
    print("\n[74] generate_reference_audio_background posts an error to the webhook when generation fails, never raises")
    import types
    captured = {}

    class _FakeHttpClient:
        def __init__(self, **kw): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, url, **kw):
            captured["webhook_payload"] = kw.get("json")
            return types.SimpleNamespace(status_code=200, text="ok")

    _httpx = sys.modules["httpx"]
    _orig_httpx = _httpx.Client
    _httpx.Client = _FakeHttpClient
    try:
        # No score_urls AND no fallback score -> _generate_reference_audio
        # returns {"error": "score with at least one measure is required"}.
        w._generate_reference_audio_background({
            "take_id": "take-456",
            "webhook_url": "https://example.test/webhook",
            "webhook_secret": "shh",
            "instrument": "Clarinet (B♭)",
            "bpm": 100,
        })
    finally:
        _httpx.Client = _orig_httpx

    payload = captured.get("webhook_payload") or {}
    check("webhook payload carries takeId even on failure", payload.get("takeId") == "take-456", str(payload))
    check("webhook payload carries the error message",
          payload.get("error") == "score with at least one measure is required", str(payload))
    check("no audio_base64 key on a failed generation", "audio_base64" not in payload, str(payload.keys()))
```

Register both in `main()`'s test tuple, directly after `test_reference_audio_endpoint_falls_back_when_fresh_read_fails,` (search for that exact line):

```python
              test_reference_audio_endpoint_falls_back_when_fresh_read_fails,
              test_reference_audio_background_posts_success_to_webhook,
              test_reference_audio_background_posts_failure_to_webhook,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 modal_worker/test_analysis.py 2>&1 | grep -B2 -A5 "\[73\]\|\[74\]"`
Expected: both `AttributeError: module 'worker' has no attribute 'generate_reference_audio_background'`.

- [ ] **Step 3: Delete the old synchronous endpoint, add the new functions**

Delete the entire `generate_reference_audio_endpoint` function (the block quoted in this task's Files section, from `@app.function(image=image, timeout=280, memory=2048)` through its closing `return _generate_reference_audio(body)`), and replace it with:

```python
def _generate_reference_audio_background(payload: dict) -> None:
    """
    Does the real reference-audio generation work, then POSTs the result to
    a webhook instead of returning it. Plain, undecorated — same reason
    _generate_reference_audio is plain: Modal's decorators (@app.function,
    @modal.fastapi_endpoint) are blanket-mocked in the local test harness,
    which turns a decorated function into an unrelated MagicMock and makes
    it untestable directly. generate_reference_audio_background below is a
    thin decorated wrapper that calls this.

    Needed because a real accuracy fix (splitting a dense score page into
    per-system row crops before vision reading, see split_page_into_rows)
    made the underlying Claude call slow enough (multiple images instead
    of one) to exceed Supabase Edge Functions' 150s wall-clock limit if
    done synchronously.

    payload needs everything _generate_reference_audio already needs
    (instrument, bpm, score_urls or score, anthropic_api_key), plus
    take_id and webhook_url (webhook_secret is optional but should always
    be sent in practice, same as run_full_analysis's payload).
    """
    take_id     = payload.get("take_id")
    webhook_url = payload.get("webhook_url")
    if not take_id or not webhook_url:
        print(f"[_generate_reference_audio_background] missing take_id or webhook_url, cannot report result: {payload.keys()}")
        return

    webhook_secret   = payload.get("webhook_secret")
    webhook_anon_key = payload.get("webhook_anon_key")

    try:
        result = _generate_reference_audio(payload)
    except Exception as e:
        print(f"[_generate_reference_audio_background] FAILED for take {take_id}: {e}")
        post_webhook(webhook_url, webhook_secret, {"takeId": take_id, "error": str(e)}, anon_key=webhook_anon_key)
        return

    if result.get("error"):
        post_webhook(webhook_url, webhook_secret, {"takeId": take_id, "error": result["error"]}, anon_key=webhook_anon_key)
        return

    post_webhook(webhook_url, webhook_secret, {
        "takeId":       take_id,
        "audio_base64": result["audio_base64"],
        "timeline":     result["timeline"],
        "bpm":          payload.get("bpm"),
    }, anon_key=webhook_anon_key)


@app.function(image=image, timeout=280, memory=2048)
def generate_reference_audio_background(payload: dict) -> None:
    """Modal-deployable wrapper, invoked via .spawn(). See _generate_reference_audio_background."""
    _generate_reference_audio_background(payload)


@app.function(image=image, timeout=30, min_containers=1)
@modal.fastapi_endpoint(method="POST", docs=True)
def generate_reference_audio_async(body: dict) -> dict:
    """
    Validates the request, spawns generate_reference_audio_background in
    the background, returns immediately — mirrors analyze_async exactly.
    Gets its OWN Modal URL (see Gotchas: "Modal URL has no path — root
    only"), separate from every other endpoint in this app.
    """
    take_id     = body.get("take_id")
    webhook_url = body.get("webhook_url")
    if not take_id or not webhook_url:
        return {"error": "take_id and webhook_url are required"}
    generate_reference_audio_background.spawn(body)
    print(f"[generate_reference_audio_async] spawned reference-audio generation for take {take_id}")
    return {"queued": True, "take_id": take_id}
```

This is the same two-function split `_generate_reference_audio`/`generate_reference_audio_endpoint` already used, for the same reason: `@app.function(...)` directly above a `def` is exactly equivalent to applying the decorator in a separate step afterward (Python decorator syntax is sugar for `f = decorator(f)`) — there is no syntactic form that keeps a *single* name both real-and-callable under the test harness's mocked `modal` module *and* deployable as a real Modal function. The only way to get both is two different names: a plain one the tests call directly, and a decorated one Modal (and `.spawn()`) uses. `generate_reference_audio_async` spawns `generate_reference_audio_background` (the decorated wrapper) — never `_generate_reference_audio_background` directly, since only a real Modal-function object has `.spawn()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 modal_worker/test_analysis.py 2>&1 | tail -10`
Expected: final line `NNN/NNN checks passed`, no `FAILED:` lines naming either new test.

- [ ] **Step 5: Verify the file still compiles**

Run: `python -m py_compile modal_worker/worker.py`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add modal_worker/worker.py modal_worker/test_analysis.py
git commit -m "feat(worker): convert reference-audio generation to spawn+webhook"
```

---

### Task 3: Edge function — `generate-reference-audio-webhook`

**Files:**
- Create: `supabase/functions/generate-reference-audio-webhook/index.ts`

**Interfaces:**
- Consumes: the exact webhook POST shape Task 2's `generate_reference_audio_background` sends — `{"takeId": <str>, "audio_base64": <str>, "timeline": [...], "bpm": <number>}` on success, `{"takeId": <str>, "error": <str>}` on failure. The `x-webhook-secret` header must equal the `MODAL_WEBHOOK_SECRET` Supabase secret (already configured — confirmed live, used by `analysis-webhook`).
- Produces: writes `takes.reference_audio_path`, `reference_audio_bpm`, `reference_audio_timeline`, `reference_audio_job_status` (`'done'` or `'failed'`), `reference_audio_job_error` (`null` on success). Returns `{"ok": true}` on success or a 4xx/5xx with `{"error": <str>}` on a malformed/unauthorized request.

- [ ] **Step 1: Write the function**

Modeled directly on `supabase/functions/analysis-webhook/index.ts`'s auth pattern (lines 65-84: shared-secret check via the `x-webhook-secret` header, service-role client) — confirmed live and unchanged as of this plan's writing.

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS })
  }

  const secret        = Deno.env.get('MODAL_WEBHOOK_SECRET')
  const incomingToken = req.headers.get('x-webhook-secret')
  if (!secret || incomingToken !== secret) {
    console.error('[generate-reference-audio-webhook] invalid or missing webhook secret')
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  const { takeId, error: jobError } = body as { takeId: string; error?: string }
  if (!takeId) {
    return new Response(JSON.stringify({ error: 'takeId is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  if (jobError) {
    console.error('[generate-reference-audio-webhook] job failed for take', takeId, ':', jobError)
    await admin.from('takes').update({
      reference_audio_job_status: 'failed',
      reference_audio_job_error:  String(jobError),
    }).eq('id', takeId)
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  const { audio_base64: audioBase64, timeline, bpm } = body as {
    audio_base64: string
    timeline: unknown
    bpm: number
  }
  if (!audioBase64) {
    return new Response(JSON.stringify({ error: 'audio_base64 is required when no error is present' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  // takeId's owner is not known here (the worker has no user session) —
  // the storage path must match what generate-reference-audio's own
  // cache-hit read expects, so it needs the owning user_id. Look it up.
  const { data: take, error: takeErr } = await admin
    .from('takes')
    .select('user_id')
    .eq('id', takeId)
    .single()
  if (takeErr || !take) {
    console.error('[generate-reference-audio-webhook] unknown take', takeId, takeErr?.message)
    return new Response(JSON.stringify({ error: 'Unknown take' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  const audioBytes  = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0))
  const storagePath = `${take.user_id}/${takeId}.wav`

  const { error: uploadErr } = await admin.storage
    .from('reference-audio')
    .upload(storagePath, audioBytes, { contentType: 'audio/wav', upsert: true })
  if (uploadErr) {
    console.error('[generate-reference-audio-webhook] storage upload failed:', uploadErr.message)
    await admin.from('takes').update({
      reference_audio_job_status: 'failed',
      reference_audio_job_error:  `Failed to store reference audio: ${uploadErr.message}`,
    }).eq('id', takeId)
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  console.log('[generate-reference-audio-webhook] writing result for take', takeId)
  await admin.from('takes').update({
    reference_audio_path:       storagePath,
    reference_audio_bpm:        bpm,
    reference_audio_timeline:   timeline ?? [],
    reference_audio_job_status: 'done',
    reference_audio_job_error:  null,
  }).eq('id', takeId)

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
})
```

Note this function does **not** create a signed URL — unlike the old synchronous flow, this webhook has no waiting HTTP caller to hand a URL back to. `generate-reference-audio` (Task 4) signs `reference_audio_path` itself the next time the frontend polls, exactly like it already does today for a cache hit.

- [ ] **Step 2: Verify the function type-checks**

Run: `cd supabase/functions/generate-reference-audio-webhook && npx --yes deno check index.ts` (or plain `deno check index.ts` if `deno` is on `PATH`). Paste the actual command output into your report.
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/generate-reference-audio-webhook/index.ts
git commit -m "feat(edge): add generate-reference-audio-webhook"
```

---

### Task 4: Edge function — make `generate-reference-audio` idempotent/pollable

**Files:**
- Modify: `supabase/functions/generate-reference-audio/index.ts` (full current content is quoted in this task so you don't need to re-derive it — verify it still matches before editing; if it doesn't, stop and report NEEDS_CONTEXT).

**Interfaces:**
- Consumes: `generate_reference_audio_async`'s exact request/response shape from Task 2 (`{take_id, webhook_url, webhook_secret, webhook_anon_key, score_urls, score, instrument, bpm, anthropic_api_key}` → `{"queued": true, "take_id": ...}` / `{"error": ...}`); the `takes` columns from Task 1.
- Produces: `POST /generate-reference-audio` still accepting `{"takeId": <string>}`, now returning one of three shapes — this exact three-way shape is what Task 5 (the frontend hook) is written against:
  - `{"status": "done", "audioUrl": <string>, "timeline": [...], "bpm": <number>, "measureRange": {...} | null}` (cache hit — same fields as today's only response shape, plus the new `status` field)
  - `{"status": "processing"}`
  - `{"status": "failed", "error": <string>}`

- [ ] **Step 1: Rewrite the function**

Replace the entire cache-miss branch (everything from `if (!take.score_path) {` through the final `return new Response(JSON.stringify({ audioUrl: ... }))` at the end of the `try` block) with the version below. The cache-hit branch above it (`if (take.reference_audio_path) { ... }`) is unchanged except for adding `status: 'done'` to its returned JSON — do not otherwise modify it.

The complete new file:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, requireAuth } from '../_shared/cors.ts'

// The cached score a take's reference audio is built from is not guaranteed
// to cover the whole piece from measure 1 — score_cache is shared across
// every take that reuses the same photographed page, and can be a partial
// parse left over from whichever take first populated it (the vision read
// can anchor on that take's own played range instead of the full page).
// Silently labelling a partial excerpt "the reference audio" reads as wrong
// content ("this doesn't sound like my piece") rather than what it is: a
// correct but incomplete window. Surface the actual measure range so the
// caller can be honest about it instead of implying full-piece coverage.
function measureRangeFromTimeline(timeline: unknown): { start: number, end: number } | null {
  if (!Array.isArray(timeline) || timeline.length === 0) return null
  const nums = timeline
    .map((t: unknown) => (t && typeof t === 'object' ? (t as { measure?: unknown }).measure : null))
    .filter((n: unknown): n is number => typeof n === 'number')
  if (!nums.length) return null
  return { start: Math.min(...nums), end: Math.max(...nums) }
}

const STUCK_JOB_MS = 5 * 60 * 1000 // matches job-status/index.ts's existing self-heal window

serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const auth = await requireAuth(req)
  if (auth instanceof Response) return auth
  const { user } = auth

  const jsonHeaders = { 'Content-Type': 'application/json', ...CORS }

  try {
    const { takeId } = await req.json()
    if (!takeId || typeof takeId !== 'string') {
      return new Response(JSON.stringify({ error: 'takeId is required' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Ownership check happens in the same query that fetches the row — a
    // take that exists but belongs to someone else returns no row, exactly
    // like a take that doesn't exist. Same pattern as job-status/index.ts.
    const { data: take, error: takeErr } = await admin
      .from('takes')
      .select('id, score_path, score_paths, instrument, declared_bpm, reference_audio_path, reference_audio_bpm, reference_audio_timeline, reference_audio_job_status, reference_audio_job_error, reference_audio_job_started_at')
      .eq('id', takeId)
      .eq('user_id', user.id)
      .single()

    if (takeErr || !take) {
      return new Response(JSON.stringify({ error: 'Take not found' }), {
        status: 404, headers: jsonHeaders,
      })
    }

    // Cache hit: already generated, return it without touching Modal.
    if (take.reference_audio_path) {
      const { data: signed, error: signErr } = await admin.storage
        .from('reference-audio')
        .createSignedUrl(take.reference_audio_path, 86400)
      if (!signErr && signed?.signedUrl) {
        return new Response(JSON.stringify({
          status: 'done',
          audioUrl: signed.signedUrl,
          timeline: take.reference_audio_timeline ?? [],
          bpm: Number(take.reference_audio_bpm),
          measureRange: measureRangeFromTimeline(take.reference_audio_timeline),
        }), { headers: jsonHeaders })
      }
      // Signing failed (e.g. the stored object was deleted out from under a
      // still-cached path) — fall through to regeneration instead of a
      // permanent dead end.
      console.warn('[generate-reference-audio] cached reference audio could not be signed, regenerating:', signErr?.message)
    }

    // A job is already in flight — report processing without re-dispatching,
    // unless it's been stuck long enough to self-heal (mirrors
    // job-status/index.ts's exact 5-minute stuck-job window).
    if (take.reference_audio_job_status === 'processing' && take.reference_audio_job_started_at) {
      const ageMs = Date.now() - new Date(take.reference_audio_job_started_at).getTime()
      if (ageMs <= STUCK_JOB_MS) {
        return new Response(JSON.stringify({ status: 'processing' }), { headers: jsonHeaders })
      }
      console.warn('[generate-reference-audio] job for take', takeId, 'stuck for', ageMs, 'ms — self-healing to failed and restarting')
    }

    if (take.reference_audio_job_status === 'failed' && !take.reference_audio_path) {
      // A prior attempt failed and nothing since has cleared it — report
      // the failure rather than silently retrying forever on every poll.
      // A fresh generate() call (not a poll) is expected to come from the
      // UI's own retry action, which the frontend triggers by calling this
      // same endpoint again — there is no separate "retry" endpoint.
    }

    if (!take.score_path) {
      return new Response(JSON.stringify({ error: 'This take has no sheet music to generate reference audio from' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    // Start a fresh job: do a FRESH, dedicated vision read of the take's own
    // score page(s) — NOT a reuse of score_cache. score_cache is shared
    // per-image content-hash across every take that reuses that exact photo,
    // and can hold a partial parse left over from whichever take first
    // populated it (confirmed live 2026-09-09 — see Gotchas: "score_cache is
    // shared per-image and can silently hold a PARTIAL parse, not the whole
    // piece"). The worker's fresh-read path always anchors at measure 1,
    // never any take's own start measure.
    //
    // score_cache is still queried, but only as a FALLBACK the worker uses
    // if the fresh read fails (network hiccup, vision call error) — a
    // possibly-partial result beats a hard failure.
    const paths = Array.isArray(take.score_paths)
      ? take.score_paths.filter((p: unknown): p is string => typeof p === 'string')
      : (take.score_path ? [take.score_path] : [])

    const signedScorePages = await Promise.all(
      paths.map((p: string) =>
        admin.storage.from('sheet-music').createSignedUrl(p, 7200)
          .then(r => r.data?.signedUrl ?? null)
          .catch(() => null)
      )
    )
    const scoreUrls = signedScorePages.every(Boolean) ? signedScorePages as string[] : []
    if (!scoreUrls.length) {
      return new Response(JSON.stringify({ error: 'Could not access the sheet music for this take' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    const scoreCacheKey = paths.length > 1 ? paths.join('|') : take.score_path
    const { data: cacheRow } = await admin
      .from('score_cache')
      .select('parsed_notes')
      .eq('score_path', scoreCacheKey)
      .maybeSingle()

    const bpm = Number(take.declared_bpm)
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
      return new Response(JSON.stringify({ error: 'This take has no valid declared tempo to generate reference audio at' }), {
        status: 400, headers: jsonHeaders,
      })
    }

    const modalUrl = Deno.env.get('MODAL_REFERENCE_AUDIO_URL')
    if (!modalUrl) {
      return new Response(JSON.stringify({ error: 'Reference audio service is not configured' }), {
        status: 500, headers: jsonHeaders,
      })
    }

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    const webhookSecret = Deno.env.get('MODAL_WEBHOOK_SECRET')

    await admin.from('takes').update({
      reference_audio_job_status: 'processing',
      reference_audio_job_started_at: new Date().toISOString(),
      reference_audio_job_error: null,
    }).eq('id', takeId)

    const spawnRes = await fetch(modalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        take_id: takeId,
        webhook_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-reference-audio-webhook`,
        webhook_secret: webhookSecret,
        webhook_anon_key: Deno.env.get('SUPABASE_ANON_KEY'),
        score_urls: scoreUrls,
        score: cacheRow?.parsed_notes ?? null,
        instrument: take.instrument ?? '',
        bpm,
        anthropic_api_key: anthropicKey,
      }),
      signal: AbortSignal.timeout(15000), // this call only kicks off a spawn — fast, not the slow vision call
    }).catch((e) => { console.warn('[generate-reference-audio] spawn dispatch failed:', e?.message); return null })

    if (!spawnRes || !spawnRes.ok) {
      await admin.from('takes').update({
        reference_audio_job_status: 'failed',
        reference_audio_job_error: 'Could not start reference audio generation',
      }).eq('id', takeId)
      return new Response(JSON.stringify({ status: 'failed', error: 'Could not start reference audio generation' }), {
        status: 502, headers: jsonHeaders,
      })
    }

    return new Response(JSON.stringify({ status: 'processing' }), { headers: jsonHeaders })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }
})
```

The `if (take.reference_audio_job_status === 'failed' && !take.reference_audio_path) { }` block above is deliberately empty — it documents that a failed job falls through to re-attempting generation on the next call (the frontend's retry path), rather than being a dead branch a future reader might mistake for missing logic.

- [ ] **Step 2: Verify the function type-checks**

Run: `cd supabase/functions/generate-reference-audio && npx --yes deno check index.ts`. Paste the actual output.
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/generate-reference-audio/index.ts
git commit -m "feat(edge): make generate-reference-audio async/pollable"
```

---

### Task 5: Frontend — poll loop in `useReferenceAudio.js`

**Files:**
- Modify: `src/hooks/useReferenceAudio.js` (full current content is quoted in this task; verify it still matches before editing, else report NEEDS_CONTEXT).

**Interfaces:**
- Consumes: `generate-reference-audio`'s new three-way response shape from Task 4 (`{status: 'done', audioUrl, timeline, bpm, measureRange}` / `{status: 'processing'}` / `{status: 'failed', error}`).
- Produces: `generate()`'s external contract is unchanged — still returns `{timeline, bpm, measureRange}` on success or `null` on failure, still sets `isLoading` while in progress — so `playRange` and `togglePlayPause` (which call `generate()`) need **no changes**. Only `generate()`'s internal implementation changes, from one `fetch` to a poll loop.

- [ ] **Step 1: Replace `generate()`'s body**

Replace the existing `generate` function (from `const generate = useCallback(async () => {` through its closing `}, [takeId, timeline, baselineBpm, measureRange])`) with:

```javascript
  const generate = useCallback(async () => {
    if (!takeId) return null
    if (audioRef.current?.src) return { timeline, bpm: baselineBpm, measureRange }
    setIsLoading(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      }
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-reference-audio`

      // Reference-audio generation now runs as a background job (a
      // multi-image vision call, see split_page_into_rows, can take well
      // over a minute) — poll the same endpoint until it reports done or
      // failed, matching NewRecordingModal.jsx's existing poll pattern
      // (5s interval, 120 attempts / 10 minutes).
      let body = null
      for (let attempt = 0; attempt < 120; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 5000))
        const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ takeId }) })
        const json = await resp.json()
        if (!resp.ok && json.status !== 'failed') throw new Error(json.error || 'Failed to generate reference audio')
        if (json.status === 'done') { body = json; break }
        if (json.status === 'failed') throw new Error(json.error || 'Failed to generate reference audio')
        // status === 'processing' -> keep polling
      }
      if (!body) throw new Error('Reference audio is taking longer than expected. Please try again in a moment.')

      if (!audioRef.current) audioRef.current = new Audio()
      audioRef.current.src = body.audioUrl
      audioRef.current.preservesPitch = true
      const freshTimeline = Array.isArray(body.timeline) ? body.timeline : []
      setTimeline(freshTimeline)
      setBaselineBpm(body.bpm)
      setTempoState(body.bpm)
      setMeasureRange(body.measureRange ?? null)
      return { timeline: freshTimeline, bpm: body.bpm, measureRange: body.measureRange ?? null }
    } catch (e) {
      setError(e.message || 'Failed to generate reference audio')
      return null
    } finally {
      setIsLoading(false)
    }
  }, [takeId, timeline, baselineBpm, measureRange])
```

The only changes from the current version: the single `fetch` + `await resp.json()` becomes a `for` loop that polls up to 120 times, and the `if (!resp.ok || body.error)` check becomes `if (!resp.ok && json.status !== 'failed')` (a `status: 'failed'` response is a well-formed, expected response even though the underlying HTTP status Task 4 returns for it is 200 for an already-known-failed job being polled, or 502 for a fresh spawn-dispatch failure — both must reach the `if (json.status === 'failed')` throw below rather than being swallowed by an `!resp.ok` check that only fires for the 502 case). Everything else in the file (`setTempo`, `clearRangeWatcher`, `playRange`, `togglePlayPause`, the cleanup effect, the returned object) is unchanged.

- [ ] **Step 2: Verify the app builds and lints clean**

Run: `npm run build`
Expected: build succeeds with no errors.

Run: `npm run lint`
Expected: no new lint errors from this file.

- [ ] **Step 3: Manual verification**

No frontend test framework exists in this repo (confirmed in a prior task tonight). This step is manual.

1. Run `npm run dev`, open a take's Analysis page with an uploaded image score and a `declared_bpm`, where `reference_audio_path` is NOT already set (clear it first if needed: `reference_audio_path = NULL` on that take's row).
2. Click "Play reference" — confirm it shows "Generating…" and *stays* on that state for longer than it used to (the vision call is now slower, sending multiple row-crop images) rather than erroring out.
3. Confirm it eventually plays — this is the first real end-to-end confirmation that the full async chain (edge function → spawn → background function → webhook → DB write → next poll sees `done`) works together, not just each piece in isolation.
4. Reload and click again — confirm it plays near-instantly (cache hit, unchanged behavior).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useReferenceAudio.js
git commit -m "feat(ui): poll for reference-audio generation instead of a single blocking request"
```

---

### Task 6: Deployment — manual steps (not automated, no code)

This task has no code changes and no tests — it documents what a human must do after Tasks 1-5 are merged and deployed, since none of it can be verified or executed from inside this repo.

- [ ] **Step 1: Apply the migration**

Apply `supabase/migrations/20260911000000_add_reference_audio_job_status.sql` to the production database before redeploying `generate-reference-audio` or `generate-reference-audio-webhook` — both read/write the new columns unconditionally. If `supabase db push` reports migration-history drift (this project has hit that before — see the CHANGELOG's 2026-09-08/09/10 entries), apply the file's SQL directly via `supabase db query --linked -f <path>` instead of fighting the drift, matching the precedent already set tonight.

- [ ] **Step 2: Deploy the worker and capture the new endpoint's URL**

After `modal deploy modal_worker/worker.py` runs, find `generate_reference_audio_async`'s URL in the deploy output or the Modal dashboard — per the documented Gotcha ("Modal URL has no path — root only"), it is a **new, distinct URL**, different from the old (now-deleted) `generate_reference_audio_endpoint`'s URL and different from `MODAL_WORKER_URL`.

- [ ] **Step 3: Update the existing Supabase secret**

Update `MODAL_REFERENCE_AUDIO_URL`'s **value** to the URL captured in Step 2 — reuse the existing secret name, do not create a new one (per this plan's Global Constraints). Use whatever mechanism this project already uses to set secrets (Supabase dashboard or `supabase secrets set MODAL_REFERENCE_AUDIO_URL=...`).

- [ ] **Step 4: Deploy both edge functions**

Deploy `generate-reference-audio` and `generate-reference-audio-webhook` the same way every other edge function in `supabase/functions/` is deployed in this project. If `generate-reference-audio-webhook` isn't yet in `.github/workflows/deploy-edge-functions.yml`'s explicit per-function step list, add it there too (matching the exact gap already found and fixed once tonight for `generate-reference-audio` itself — see the CHANGELOG's 2026-09-09 entry).

- [ ] **Step 5: End-to-end smoke test**

With all of the above live, run Task 5 Step 3's manual verification against the real deployed stack. This is the point where the full async chain gets tested together against production infrastructure (Modal spawn latency, Supabase webhook delivery, real polling cadence) for the first time — every earlier task's tests exercise each piece individually with mocks.

---

## Spec coverage check

| Spec section | Task |
|---|---|
| Migration (`reference_audio_job_status`/`_job_error`/`_job_started_at`) | Task 1 |
| `generate_reference_audio_async` (mirrors `analyze_async`) | Task 2 |
| `generate_reference_audio_background` (mirrors `run_full_analysis`, calls `post_webhook`) | Task 2 |
| Delete old synchronous `generate_reference_audio_endpoint` | Task 2 |
| `generate-reference-audio-webhook` (mirrors `analysis-webhook`) | Task 3 |
| `generate-reference-audio` becomes idempotent/pollable (cache-hit / processing+self-heal / spawn-and-return) | Task 4 |
| Frontend poll loop (mirrors `NewRecordingModal.jsx`, 5s/120 attempts) | Task 5 |
| Deployment: new Modal URL, reused secret name, migration-before-deploy ordering, missing CI step | Task 6 |
| No new Supabase secret (`MODAL_WEBHOOK_SECRET` reused) | Task 3 (consumes existing secret, doesn't introduce one) |
| Testing: worker (mocked webhook POST + vision call), edge functions (`deno check`), manual end-to-end | Tasks 2, 3, 4, 5, 6 |
