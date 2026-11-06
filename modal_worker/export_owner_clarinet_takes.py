"""
"MEDIANT — Recover Authorized Access to Existing Clarinet Recordings"
(2026-11-05). Task 2 deliverable: the smallest script that exports
audio from the owner's own video takes, using ONLY the authorized
route Task 1 confirmed already exists in the app itself
(`src/pages/Analysis.jsx:947-950`:
`supabase.storage.from('recordings').createSignedUrl(take.video_path, 7200)`,
gated by the live, confirmed, unchanged RLS policy "Users can read own
recordings" on `storage.objects`).

**Run this yourself, on your own machine, as the account owner — it
is NOT run by the agent.** It signs in with YOUR OWN Supabase email +
password (the same login you already use for the real app) via the
public anon key already embedded in this repo's `.env`
(`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — these are the same
public, non-secret keys the shipped frontend already uses; this is
not a service-role key and does not bypass RLS). Your password is
only ever typed into a local, non-echoing prompt (`getpass`) and sent
directly to Supabase's own Auth API over HTTPS — it is never printed,
logged, or stored by this script, and this agent never sees it.

What it does, entirely under YOUR OWN RLS-scoped session (never an
admin/service-role bypass):
  1. Signs in as you (`POST /auth/v1/token?grant_type=password`).
  2. Queries YOUR OWN `takes` rows only (RLS already restricts this to
     `auth.uid() = user_id` -- the same restriction that applies when
     you use the app normally) for `job_status = 'done'` AND a score
     path present -- the same 53-take criterion already established
     this week.
  3. For each, calls `createSignedUrl` on YOUR OWN video (the exact
     same call the app's own Analysis page already makes to play your
     recordings back to you) and downloads it locally.
  4. Runs `worker.extract_audio_from_video` (modal_worker/worker.py:557,
     imported unchanged, not modified or touched) -- the SAME ffmpeg
     wrapper production already uses for every take -- to produce a
     mono 22050Hz WAV per take, saved locally.

No production code was changed. No service-role key is used, created,
or requested. No third-party (the other 140 takes) recording is ever
queried, downloaded, or referenced -- RLS makes that structurally
impossible for this script even if it tried, since your own session
can only ever see your own `user_id` rows.

Output: `<out_dir>/<take_id>.wav` plus `<out_dir>/manifest.json`
(take_id, piece_title, instrument, score_path, original video path --
metadata only, matching the manifest shape already used elsewhere
this week).
"""
import getpass
import json
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
import worker as w  # noqa: E402  (extract_audio_from_video, unmodified)

REPO_ROOT = Path(__file__).parent.parent


def read_env_var(name: str) -> str:
    for env_file in (REPO_ROOT / ".env",):
        if not env_file.exists():
            continue
        for line in env_file.read_text().splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError(f"{name} not found in .env")


def main():
    supabase_url = read_env_var("VITE_SUPABASE_URL")
    anon_key = read_env_var("VITE_SUPABASE_ANON_KEY")

    email = input("Your Mediant login email: ").strip()
    password = getpass.getpass("Your Mediant login password (not echoed, not logged): ")

    auth_resp = requests.post(
        f"{supabase_url}/auth/v1/token?grant_type=password",
        headers={"apikey": anon_key, "Content-Type": "application/json"},
        json={"email": email, "password": password},
        timeout=30,
    )
    auth_resp.raise_for_status()
    access_token = auth_resp.json()["access_token"]
    user_id = auth_resp.json()["user"]["id"]
    print(f"Signed in as {email} (user_id={user_id})")

    headers = {"apikey": anon_key, "Authorization": f"Bearer {access_token}"}

    # Step 2: your own takes only -- RLS (auth.uid() = user_id) enforces
    # this regardless of the filter below; it is not relied upon alone.
    takes_resp = requests.get(
        f"{supabase_url}/rest/v1/takes",
        headers=headers,
        params={
            "select": "id,piece_title,piece_composer,instrument,video_path,score_path,score_paths,job_status",
            "job_status": "eq.done",
            "or": "(score_path.not.is.null,score_paths.not.is.null)",
        },
        timeout=30,
    )
    takes_resp.raise_for_status()
    takes = takes_resp.json()
    print(f"Found {len(takes)} eligible takes under your own account")

    out_dir = REPO_ROOT.parent / "mediant_owner_clarinet_export"
    out_dir.mkdir(exist_ok=True)
    manifest = []

    for t in takes:
        video_path = t.get("video_path")
        if not video_path:
            continue
        sign_resp = requests.post(
            f"{supabase_url}/storage/v1/object/sign/recordings/{video_path}",
            headers=headers,
            json={"expiresIn": 7200},
            timeout=30,
        )
        if sign_resp.status_code != 200:
            print(f"  {t['id']}: could not sign URL ({sign_resp.status_code}), skipping")
            continue
        signed_path = sign_resp.json()["signedURL"]
        video_resp = requests.get(f"{supabase_url}/storage/v1{signed_path}", timeout=120)
        video_resp.raise_for_status()

        wav_bytes, duration = w.extract_audio_from_video(video_resp.content)
        wav_path = out_dir / f"{t['id']}.wav"
        wav_path.write_bytes(wav_bytes)
        manifest.append({**{k: t[k] for k in ("id", "piece_title", "piece_composer", "instrument")},
                          "duration_sec": duration, "wav_file": wav_path.name})
        print(f"  {t['id']}: exported {wav_path.name} ({duration:.1f}s)")

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} takes exported to {out_dir}")


if __name__ == "__main__":
    main()
