# CREPE Input-Contract Verification on HARPSET — 2026-11-08

**Status: root-cause check only. No fix applied — none was found to
apply. `worker.py` untouched throughout, as required regardless of
outcome. No new model, no threshold change, no new detector.**

---

## Task 1 — input preparation, traced stage by stage

Traced the EXACT same code path `harpset_evaluation.py` already calls
(`worker.run_pitch_tracking`, unmodified, same instrument string
`"Harp"`) side by side on one HARPSET recording (`01_O_Recording.wav`)
and one previously-working MusicNet recording
(`2288.wav`, Violin — the piece this week's Basic Pitch/Parangonar
work has used repeatedly, confirmed to produce normal CREPE output all
week).

| Stage | HARPSET 01_O | MusicNet 2288 (working) |
|---|---|---|
| Raw file | 44100 Hz, stereo, **PCM_24**, 25.54s | 44100 Hz, mono, FLOAT, 191.74s |
| After `librosa.load(sr=22050, mono=True)` | shape (563106,), float32, **all finite**, min −0.2048, max 0.2053, RMS 0.0348 | shape (4227840,), float32, all finite, min −0.9384, max 0.9463, RMS 0.0840 |
| After resample to 16000 Hz | shape (408603,), float32, **all finite**, RMS 0.0348 (unchanged) | shape (3067821,), float32, all finite, RMS 0.0839 |
| `audio_tensor` into `torchcrepe.predict` | shape (1, 408603), `torch.float32`, **all finite** | shape (1, 3067821), `torch.float32`, all finite |
| `_instrument_pitch_bounds("Harp")` | fmin=27.5, fmax=2093.0 (correct — same wide A0–C7 range given to piano/keyboard) | fmin=196.0, fmax=2093.0 |
| CREPE confidence (periodicity) | **min 0.0000, mean 0.0002, max 0.0162** | min 0.0018, mean 0.7495, max 0.9478 |
| Frames with confidence ≥0.30 | **0 / 639** | 4466 / 4794 |
| CREPE pitch estimate range | **1789.4–1958.7 Hz** (clustered right against the 2093 Hz ceiling) | 198.5–1958.7 Hz (spans the instrument's real register) |

**Every stage checked by the directive is structurally and numerically
correct for the HARPSET file**: 24-bit PCM is decoded cleanly to
float32 with no clipping, no NaN/Inf, no shape mismatch; stereo is
correctly averaged to mono (output is 1-D); resampling lands exactly
on `torchcrepe.SAMPLE_RATE` (16000, confirmed directly from the
installed library — `torchcrepe.SAMPLE_RATE == 16000`), so
`torchcrepe.preprocess`'s own internal resample branch
(`if sample_rate != SAMPLE_RATE`) never triggers a redundant/incorrect
second resample; the tensor shape/dtype exactly matches
`torchcrepe.predict`'s documented contract
(`torch.tensor [shape=(1, time)]`).

**Per-frame normalization — checked directly against `torchcrepe`'s
own source, not assumed:** `torchcrepe.core.preprocess` performs its
own internal per-frame normalization on every 1024-sample analysis
window, AFTER windowing and BEFORE the model sees it:

```python
# Mean-center
frames -= frames.mean(dim=1, keepdim=True)
# Scale
frames /= torch.max(torch.tensor(1e-10, device=frames.device),
                    frames.std(dim=1, keepdim=True))
```

This is a standard per-frame z-score normalization, applied
automatically regardless of the caller's own waveform amplitude. **It
rules out "the audio is too quiet" or "amplitude scaling is wrong" as
a cause by design** — HARPSET's RMS (0.0348) being roughly 2.4x
quieter than MusicNet's (0.0840) cannot be the reason for a confidence
gap this large (0.0002 mean vs 0.7495 mean, roughly 3700x), because
every analysis frame gets re-normalized to zero mean / unit variance
before the model ever sees it.

**Reference contract comparison** (per the directive's allowance to
compare against the documented contract rather than clone/run the
original repo): the original CREPE paper and the `marl/crepe`
reference implementation expect 16kHz mono input with the same
1024-sample analysis window and per-frame normalization this `torchcrepe`
port implements identically (confirmed by reading its own source,
above) — the input contract this project's code honors matches the
documented reference contract exactly.

---

## Task 2 — binary determination: **B**

**No input-processing defect was found.** Every element of the
checklist (sample rate, stereo/mono, 24-bit decoding, array shape/
dtype, finite values, RMS, resampling to 16kHz, per-frame
normalization) is correct and structurally identical in form to the
already-working MusicNet path. The one real anomaly found — CREPE's
pitch estimates clustering tightly against the 2093 Hz fmax ceiling
rather than spanning the piece's actual (much lower) register — is not
an input bug; it is the signature of a model producing a near-arbitrary
decode when it has no genuine periodicity to lock onto, consistent
with the confidence distribution being near-zero across the *entire*
recording, not just borderline-low in a few places.

**Per the directive: classified as genuine CREPE incompatibility with
this harp evaluation content. STOP — no new threshold, enhancement
filter, or replacement pitch model attempted.**

The likely (not further investigated, per scope) mechanism: `worker.py`
deliberately uses CREPE's lightweight `"tiny"` model capacity for
production speed (its own comment: *"Use the supported lightweight
CREPE model here so ~1 minute takes finish reliably"*), and CREPE's
training data (per the original paper) emphasizes sustained/bowed/
vocal monophonic pitch content. A harp pluck's fast attack transient,
strong initial inharmonicity, and rapid decay differ substantially
from that profile — plausible, not confirmed, and explicitly not
chased further this round, since doing so (testing model capacity,
retraining, or a different pitch tracker) is exactly the "new
threshold / enhancement filter / replacement pitch model" work this
directive's own Task 2-B branch says to stop at.

---

## Task 3 — not applicable

No input-processing defect was confirmed or corrected, so Task 3's
re-run (voiced-frame coverage, HARPSET detection numbers, MusicNet
comparison) does not apply, per the directive's own branching. The
failing confidence distribution is reported above in full (Task 1's
table) instead.

**No change to any previously reported HARPSET or MusicNet number.**
Last round's results (`modal_worker/harpset_evaluation.py`, commit
`8a83ea5`) stand as measured: Candidate A and the cross-model-gated
Candidate B remain structurally non-functional on this corpus because
CREPE genuinely cannot process it — confirmed here to be a real
property of the model/content combination, not a bug in how this
project prepares audio for it.
