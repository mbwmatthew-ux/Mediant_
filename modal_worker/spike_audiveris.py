"""
Throwaway spike — NOT part of the app. Tests whether Audiveris can produce
ANY usable output on a single already-cleaned row crop from today's real
problem photo, before committing to a real integration.

Self-contained (does NOT import worker.py) — an earlier version imported
`image`/`app` from worker.py, which works locally but fails remotely:
Modal only ships the entrypoint module's own file to the container, not
sibling files it imports at module scope, so the container crash-looped on
`ModuleNotFoundError: No module named 'worker'` for the entire run without
ever executing Audiveris once. Duplicating the tiny apt_install block here
avoids that failure mode entirely for a one-off spike.

Run with: modal run spike_audiveris.py --row-path <path to a PNG row crop>
"""
import modal

app = modal.App("audiveris-spike")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates")
    .run_commands(
        "curl -L -o /tmp/audiveris.deb https://github.com/Audiveris/audiveris/releases/download/5.10.2/Audiveris-5.10.2-ubuntu22.04-x86_64.deb && dpkg-deb -x /tmp/audiveris.deb / && if [ -x /opt/audiveris/bin/Audiveris ]; then ln -sf /opt/audiveris/bin/Audiveris /usr/local/bin/audiveris; elif [ -x /opt/audiveris/bin/audiveris ]; then ln -sf /opt/audiveris/bin/audiveris /usr/local/bin/audiveris; else find /opt -iname '*audiveris*' -maxdepth 4; exit 1; fi && audiveris -version && rm /tmp/audiveris.deb",
    )
)


@app.function(image=image, timeout=280)
def audiveris_spike(row_bytes: bytes) -> dict:
    import subprocess
    import tempfile
    import os

    with tempfile.TemporaryDirectory() as tmpdir:
        home_dir = os.path.join(tmpdir, "home")
        input_path = os.path.join(tmpdir, "row.png")
        output_dir = os.path.join(tmpdir, "audiveris-output")
        for path in (home_dir, output_dir):
            os.makedirs(path, exist_ok=True)
        with open(input_path, "wb") as f:
            f.write(row_bytes)

        env = {
            **os.environ,
            "HOME": home_dir,
            "JAVA_TOOL_OPTIONS": "-Djava.awt.headless=true",
        }
        command = ["audiveris", "-batch", "-transcribe", "-export",
                   "-output", output_dir, "--", input_path]
        try:
            result = subprocess.run(command, capture_output=True, text=True,
                                     timeout=250, env=env)
            rc, stdout, stderr = result.returncode, result.stdout, result.stderr
        except subprocess.TimeoutExpired as e:
            rc, stdout, stderr = -1, e.stdout or "", (e.stderr or "") + "\n[TIMED OUT after 250s]"

        exported = []
        for root, _, files in os.walk(output_dir):
            for fn in files:
                exported.append(os.path.join(root, fn))
        musicxml = None
        for p in exported:
            if p.lower().endswith((".xml", ".mxl")):
                with open(p, "rb") as f:
                    musicxml = f.read()
                break
        return {
            "returncode": rc,
            "stdout_tail": (stdout or "")[-3000:],
            "stderr_tail": (stderr or "")[-3000:],
            "exported_files": exported,
            "musicxml_bytes": len(musicxml) if musicxml else 0,
            "musicxml_preview": musicxml[:1500].decode("utf-8", "replace") if musicxml else None,
        }


@app.local_entrypoint()
def main(row_path: str):
    with open(row_path, "rb") as f:
        row_bytes = f.read()
    result = audiveris_spike.remote(row_bytes)
    print("returncode:", result["returncode"])
    print("exported_files:", result["exported_files"])
    print("musicxml_bytes:", result["musicxml_bytes"])
    print("\n--- stdout tail ---")
    print(result["stdout_tail"])
    print("\n--- stderr tail ---")
    print(result["stderr_tail"])
    if result["musicxml_preview"]:
        print("\n--- musicxml preview ---")
        print(result["musicxml_preview"])
