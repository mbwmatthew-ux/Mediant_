# Security hardening — round 2 (2026-07-02)

Follow-up to `SECURITY_UX_AUDIT_2026-07-01.md`. A second, deeper adversarially-verified
audit of the whole app produced 19 confirmed findings. Code fixes are committed and pushed
to `main` (commit `90bf032`). App is pre-launch, no external users, payments not live.

This doc is the checklist to make the fixes **live** — pushing code is not enough; the DB
migration must be applied and the edge functions redeployed.

---

## Status legend
- ✅ DONE (in code, on `main`)
- 🟡 NEEDS DEPLOY / DASHBOARD ACTION (owner)

---

## 1. Database (RLS) — ✅ code + 🟡 apply
File: `supabase/migrations/20260702_security_hardening_2.sql` (idempotent; supersedes
`20260701_security_hardening.sql`).

Fixes:
- **score_cache had NO RLS** — the only table missing `ENABLE ROW LEVEL SECURITY`, so it
  was fully readable/writable via the public anon key (cache poisoning: an attacker could
  write the "correct notes" a victim is graded against). → RLS enabled, anon/authenticated
  revoked; service role still works (it bypasses RLS).
- **profiles.role self-promotion** — anyone could set their own `role='teacher'`. → BEFORE
  INSERT/UPDATE trigger pins `role`; only the service role can grant `teacher`.
- **Forgeable active teacher→student link** — `ts_teacher_all` was `FOR ALL` with
  `WITH CHECK` only on `teacher_id`, so any user could `INSERT {teacher_id: self,
  student_id: victim, status:'active'}` with no consent, which the teacher-read policies on
  `profiles`/`reference_performances` then trusted. → replaced with SELECT/DELETE-only
  policies; all invite/accept flows go through the service-role `teacher-students` function.
- Dropped the client self-insert subscription policy and `ts_student_update`; added the
  missing `profiles` `WITH CHECK`.

**Action:** apply via `supabase db push`, or paste the file into the SQL editor and Run.
> Al already applied this via the SQL editor on 2026-07-02. Confirm it's present (see
> "Verify" below) or re-run — it's idempotent.

## 2. Edge functions — ✅ code + 🟡 deploy
Redeploy these from latest `main`:
- `analyze-performance` — **IDOR fix**: now verifies the caller owns `videoPath` /
  `scorePath` / `songId` (`${user.id}/…`) before minting service-role signed URLs. Was:
  hand it any path and it read that private file into your analysis. Also escapes
  `pieceTitle` in the outgoing email HTML.
- `send-welcome-email` — now requires a valid JWT and only sends to the caller's own
  verified email. Was: an open, unauthenticated Mediant-branded email relay.
- `delete-account` — now also removes `user_pieces` + `reference-midi` storage objects and
  `reference_performances` rows. Was: those private files/rows were orphaned on deletion.
- `redeem-teacher-code` — **NEW** function. Sanctioned teacher upgrade gated by the
  `TEACHER_INVITE_CODE` secret; fails closed if unset.

**Action:**
```bash
git checkout main && git pull
supabase functions deploy analyze-performance
supabase functions deploy send-welcome-email
supabase functions deploy delete-account
supabase functions deploy redeem-teacher-code
```
All four use JWT auth internally — deploy with the default (verify_jwt on). Do NOT pass
`--no-verify-jwt` for these (that flag is only for the webhooks: stripe-webhook,
analysis-webhook, which are unchanged this round).

## 3. Secrets / config — 🟡 dashboard
- **`TEACHER_INVITE_CODE`** — set a long random string (Project Settings → Edge Functions
  → Secrets, or `supabase secrets set TEACHER_INVITE_CODE=...`). Until set, teacher signup
  is closed (safe default). Share the code only with vetted teachers.
- **Rotate the Anthropic API key** (still open from the 2026-07-01 audit): create a new key
  in the Anthropic console, update `ANTHROPIC_API_KEY` in Supabase secrets AND the Modal
  worker, then revoke the old key.

## 4. Modal worker — 🟡 (still open from 2026-07-01)
Harden per the prior audit: validate/lock down any caller-supplied URLs the worker fetches
(SSRF), and confirm secrets aren't logged. See `SECURITY_UX_AUDIT_2026-07-01.md`.

## 5. Product decision (not a bug) — Al + Matthew
`analyze-performance` has NO server-side rate limit / free-tier gate (the check is
commented out, lines ~1146–1158). Any authenticated user can trigger unlimited expensive
AI jobs. Re-enable a limit before launch; the right numbers depend on final pricing (still
placeholders in `src/lib/pricing.js`).

---

## Verify (optional, in the SQL editor)
```sql
-- score_cache RLS should be true:
select relname, relrowsecurity from pg_class where relname = 'score_cache';
-- role guard trigger should exist:
select tgname from pg_trigger where tgname = 'profiles_role_guard';
-- teacher policies should be select/delete only (no ts_teacher_all):
select policyname, cmd from pg_policies where tablename = 'teacher_students';
```
