# Security incident — Gemini API key committed and leaked, 2026-10-30

## What happened

A Google Gemini API key (test-only, used for the Task 4A/4B validation
pilots — never Mediant's production Gemini credential, confirmed with the
owner 2026-10-30) was hardcoded as a literal string in
`modal_worker/run_task4a_gemini_pilot.py`. That file was committed
(`49e7d45`) and pushed to `github.com/mbwmatthew-ux/Mediant_`, which is a
**public** repository. Google auto-revoked the key mid-run during Task 4B,
returning `403 PERMISSION_DENIED: "Your API key was reported as leaked."`
— almost certainly triggered by GitHub's automated secret-scanning
partnership with Google, which scans public pushes for recognizable
credential patterns and reports matches to the issuing provider.

The same hardcoded-literal pattern had been copied into the
not-yet-committed `run_task4b_gemini_pilot.py` at the time of discovery;
it was never pushed in that state.

## Impact assessment

- **Confirmed test-only.** Owner confirmed (2026-10-30) this key was never
  wired into Mediant's production Gemini path. No production secret or
  Modal secret was found to share this value — `.env`, `mobile/.env`, and
  `modal secret list` were all checked and show no matching credential.
- **Full-history scan performed.** `git log --all -p` was searched for
  this key's pattern and for common credential patterns generally
  (Google API keys, Anthropic keys, GitHub tokens, Slack tokens, AWS
  access keys, PEM private key headers, Supabase service-role usage,
  JWT-shaped strings). The only matches were: (a) this one Gemini key,
  and (b) a JWT-shaped string inside `node_modules/zod/.../string.test.ts`
  — a third-party library's own bundled test fixture, not a Mediant
  credential. Every `serviceRoleKey`/`serviceKey` reference found is
  `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` — read from environment at
  runtime, never a literal. No other exposed credential was found.

## Remediation applied

- Both `run_task4a_gemini_pilot.py` and `run_task4b_gemini_pilot.py` now
  read `GOOGLE_AI_API_KEY` from the environment
  (`os.environ["GOOGLE_AI_API_KEY"]`) — no literal key value in either
  file, verified by direct grep before every subsequent commit and push.
- A replacement key was issued by the owner and used only via the shell
  environment for the Task 4B rerun — verified absent from the working
  tree, the pending commit, and the local run log before pushing.
- Commit `4ed94cd` (containing this fix plus Task 4B's results) was
  verified clean by this process and pushed to `origin/main` normally
  (`49e7d45..4ed94cd`), no force-push, no history rewrite.

## What was NOT done: historical git removal

The dead key string still exists in commit `49e7d45`'s diff, reachable via
`git log -p` and GitHub's own history view, because git history was not
rewritten. **Evaluated and not recommended, pending any future change of
mind:** the key is permanently revoked by Google and non-functional (
reconfirmed via a free API call returning `400 INVALID_ARGUMENT` — not
even recognized as a key shape anymore, let alone a valid one) — the
exposed string is inert. Rewriting history on a public repo to remove it
would require a force-push, which breaks any existing clones, forks, or
open PRs, and is a disproportionately disruptive action for a credential
that cannot be used by anyone regardless. The owner confirmed this
tradeoff explicitly (2026-10-30, "leave it"). This note records that
decision; rewriting history was not performed and would need separate
approval if revisited.

## Residual follow-up (not verifiable from this environment)

- **New key restrictions.** This environment has no browser/OAuth access
  to Google AI Studio or Cloud Console, so the new key's API restrictions
  (e.g. limited to the Generative Language API only) and any usage quota
  or budget alert could not be checked programmatically. Recommend the
  owner verify these directly in Google AI Studio / Cloud Console.
- **Going forward:** no script in this repo should ever contain a literal
  credential. The pattern now in both pilot scripts — read from
  `os.environ`, fail loudly if unset — is the one to copy for any future
  throwaway/validation script that needs a real API key.
