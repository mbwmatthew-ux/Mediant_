# Recover Authorized Access to Existing Clarinet Recordings — 2026-11-05

**Status: authorized access route confirmed and a minimal export
script written. Nothing was downloaded or extracted by the agent —
the script requires the owner's own login, which the agent does not
have and did not request.** No production code changed, no
service-role key created or used, no RLS bypass, no third-party
recording touched or queried.

---

## Task 1 — authorized access check: CONFIRMED, with exact evidence

Read the real frontend code, not assumed. `src/pages/Analysis.jsx:947-950`:

```js
if (take.video_path) {
  supabase.storage
    .from('recordings')
    .createSignedUrl(take.video_path, 7200)
```

This is the app's own existing playback path — when the account owner
opens one of their own takes in Analysis, the app calls
`createSignedUrl` through the normal `supabase-js` client, under the
viewing user's OWN authenticated session. This is not a special or
hidden route; it's the exact code every real user already relies on to
watch their own recordings play back.

**Checked the live RLS policy, not just the migration file,** via
`supabase db query --linked` (read-only `pg_policies` metadata query,
same already-authenticated tooling as every round this week):

```
policyname: "Users can read own recordings"
cmd: SELECT
qual: (bucket_id = 'recordings') AND ((storage.foldername(name))[1] = auth.uid()::text)
```

**Live and unchanged** — confirmed directly against the running
database, not inferred from the original migration. The account
owner's own authenticated session satisfies this policy for every one
of their own 92 files (their files live under a folder keyed by their
own `auth.uid()`), and for no one else's. **This is a real, already-
built, already-working authorized access route.** No service-role
secret is needed, requested, or exposed. No RLS bypass is involved —
the policy itself is what grants the access.

**Stop condition NOT hit.** A route exists; Tasks 2-3 proceed.

---

## Task 2 — minimal media export: specified and written, not run

Wrote `modal_worker/export_owner_clarinet_takes.py` — the smallest
script that exercises the Task 1 route end-to-end. It:

1. Signs in with the owner's OWN email + password (typed locally via
   `getpass`, never echoed, logged, or seen by this agent) against
   Supabase's public Auth API, using the same public anon key
   (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`) already embedded in
   the shipped frontend's `.env` — not a secret, not a service-role
   key.
2. Queries the signed-in user's own `takes` rows (RLS already
   restricts this to their own `user_id` regardless of any filter the
   script adds) for `job_status='done'` and a score present.
3. For each, calls the exact same `createSignedUrl` the app's own
   Analysis page already calls, downloads the resulting file.
4. Runs `worker.extract_audio_from_video` (`modal_worker/worker.py:557`,
   **imported unchanged, not modified** — the same `ffmpeg -vn -acodec
   pcm_s16le -ar 22050 -ac 1` wrapper production already uses for
   every take) to produce a mono 22050Hz WAV locally.

**Dependency check, done for real:** `ffmpeg` is installed locally
(`/opt/homebrew/bin/ffmpeg`, confirmed via `which`/`-version`).
`requests` (2.34.2) and a clean import of `worker.extract_audio_from_video`
were both verified directly in the existing isolated validation venv
— the script's syntax and every non-interactive dependency were
checked; the interactive sign-in itself was not exercised, since doing
so requires the owner's own credentials, which this agent does not
have and should not be given over chat. **No new media-management
system was built** — this is one linear script reusing three already-
existing pieces (the app's own signed-URL call, the public anon key,
and the production `extract_audio_from_video` function) with no new
abstraction layer.

**To actually run it, the owner needs to run it themselves:**
```
cd modal_worker
source /Users/matthewwu/.cache/mediant_validation/venv/bin/activate
python3 export_owner_clarinet_takes.py
```
It will prompt for the owner's own Mediant login email and password
(local prompt only) and write WAV files + a metadata manifest to
`mediant_owner_clarinet_export/` next to the repo.

---

## Task 3 — evaluation subset identified (metadata only, no labels created)

Re-confirmed the exact count under the stated criterion (completed
job, score present), scoped only to the owner's 92-take account —
**the same figure already established, re-verified here rather than
restated as new**:

| Criterion | Count |
|---|---|
| Owner's takes, `job_status='done'`, score present | **53** |
| ...of those, with `instrument` labeled | 40 (all Clarinet) |
| ...of those, with no `instrument` label | 13 (score present, instrument field unset — likely older takes) |

**These 53 are the subset the export script (Task 2) targets and the
subset eligible for offline verification once exported.** No error
labels have been created from either detector's own predictions —
per the standing rule this entire investigation has held to all week,
`flags` already on these takes (production's own imperfect output)
would need independent human listening to confirm anything, exactly
as specified in every prior round's "ground truth" sections. That
listening cannot happen until the audio is actually exported (Task 2),
which requires the owner's own credentials.

**Zero third-party takes were queried, downloaded, or referenced for
this task.** The RLS policy itself makes this structurally
impossible for the export script even if misused — a session
authenticated as the owner can never see another user's `user_id`
rows or storage folder, regardless of what the script's own filters
ask for.

---

## Summary

- **Authorized access route: confirmed real, already built, no
  changes needed.**
- **Minimal export script: written, dependency-checked, not run** —
  running it requires the owner's own login, entered locally by them.
- **53 takes identified** as the Task 3 evaluation subset once
  exported — all Clarinet (where labeled).
- **No recording content was accessed by the agent at any point.**
- **One precise next action:** the owner runs
  `modal_worker/export_owner_clarinet_takes.py` themselves, which
  produces up to 53 local WAV files + a manifest; a following round
  can then do the actual human-verification + detector-comparison
  work this week's evaluation infrastructure (production's
  `find_wrong_note_candidates`, the Basic Pitch + `AudioToScoreMatcher`
  adapter, `note_sequence_evaluator.py`) is already built for.
