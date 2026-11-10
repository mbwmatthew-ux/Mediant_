"""
BP_PY / BP_SCRIPT, extracted out of score_conditioned_error_classifier.py so
they can be imported without that file's module-level `from harpset_evaluation
import ...` (a local validation-only dataset dependency not shipped to any
Modal container) and without partitura/parangonar/sklearn at import time.

score_conditioned_error_classifier.py imports these FROM here (not
redefined) so there is exactly one definition. worker.py's _run_analysis_v2
imports from here directly for the same reason.
"""
from __future__ import annotations

import os

# Configurable so worker.py's _run_analysis_v2 can point this at the staging
# container's /opt/mediant-bp/bin/python3 (built by worker.py's
# MEDIANT_BUILD_ANALYSIS_V2 image step) via MEDIANT_BP_PYTHON, while local
# validation runs keep using the macOS CoreML-backed venv by default.
BP_PY = os.environ.get(
    "MEDIANT_BP_PYTHON",
    "/Users/matthewwu/.cache/mediant_validation/venv_basic_pitch/bin/python3",
)

BP_SCRIPT = r"""
import sys, time, numpy as np
from basic_pitch.inference import predict
from basic_pitch.note_creation import model_frames_to_time
audio_path, out_path = sys.argv[1], sys.argv[2]
t0 = time.time()
model_output, _, _ = predict(audio_path)
elapsed = time.time() - t0
note = np.asarray(model_output["note"], dtype=np.float32)
onset = np.asarray(model_output["onset"], dtype=np.float32)
contour = np.asarray(model_output["contour"], dtype=np.float32)
times = np.asarray(model_frames_to_time(note.shape[0]), dtype=np.float64)
np.savez(out_path, note=note, onset=onset, contour=contour, times=times,
         bp_seconds=np.array(elapsed))
print("OK", note.shape, onset.shape, contour.shape)
"""
