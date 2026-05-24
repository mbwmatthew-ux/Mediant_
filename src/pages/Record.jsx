import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getFile } from '../lib/fileStore'
import styles from './Page.module.css'

const INSTRUMENTS = [
  'Piano', 'Violin', 'Viola', 'Cello', 'Double Bass',
  'Flute', 'Oboe', 'Clarinet', 'Bassoon',
  'French Horn', 'Trumpet', 'Trombone', 'Tuba',
  'Guitar', 'Harp', 'Voice', 'Other',
]

const OCR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])

export default function Record() {
  const nav      = useNavigate()
  const { user } = useAuth()

  // Sheet music (required)
  const [scoreFile,    setScoreFile]    = useState(null)
  const [scoreDrag,    setScoreDrag]    = useState(false)
  const [ocrLoading,   setOcrLoading]   = useState(false)
  const scoreInputRef = useRef()

  // Auto-filled piece info (from OCR, editable)
  const [pieceTitle,    setPieceTitle]    = useState('')
  const [composer,      setComposer]      = useState('')
  const [instrument,    setInstrument]    = useState('')
  const [part,          setPart]          = useState('')
  const [timeSig,       setTimeSig]       = useState('4/4')
  const [keySignature,  setKeySignature]  = useState('')
  const [startMeasure,  setStartMeasure]  = useState('')
  const [endMeasure,    setEndMeasure]    = useState('')

  // Video recording (required)
  const [file,      setFile]      = useState(null)
  const [videoDrag, setVideoDrag] = useState(false)
  const videoInputRef = useRef()

  // Submission state
  const [phase,    setPhase]    = useState('idle')  // idle | uploading | analyzing | error
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [errorDetails, setErrorDetails] = useState([])

  const readyToAnalyze = Boolean(scoreFile && file && instrument)

  // Pre-fill from library "Start Recording" click
  useEffect(() => {
    async function applyPrefill() {
      try {
        const raw = sessionStorage.getItem('mediant_prefill')
        if (!raw) return
        sessionStorage.removeItem('mediant_prefill')
        const { pieceTitle: t, composer: c, instrument: ins, key: k, timeSig: ts, pieceId } = JSON.parse(raw)
        if (t)   setPieceTitle(t)
        if (c)   setComposer(c)
        if (ins && INSTRUMENTS.includes(ins)) setInstrument(ins)
        if (k)   setKeySignature(k)
        if (ts)  setTimeSig(ts)
        if (pieceId) {
          const f = await getFile(pieceId)
          if (f) setScoreFile(f)
        }
      } catch { /* ignore */ }
    }
    applyPrefill()
  }, [])

  // ── OCR: auto-fill title/composer from sheet music photo ──────

  async function runOcr(f) {
    if (!OCR_TYPES.has(f.type)) return  // skip for XML/MXL
    setOcrLoading(true)
    try {
      const buf  = await f.arrayBuffer()
      const b64  = btoa(String.fromCharCode(...new Uint8Array(buf)))
      const { data } = await supabase.functions.invoke('analyze-sheet-music', {
        body: { imageBase64: b64, mediaType: f.type },
      })
      if (data?.title)    setPieceTitle(data.title)
      if (data?.composer) setComposer(data.composer)
      if (data?.time)     setTimeSig(data.time)
    } catch { /* silently skip — user can fill manually */ }
    finally { setOcrLoading(false) }
  }

  function handleScoreDrop(e) {
    e.preventDefault()
    setScoreDrag(false)
    const f = e.dataTransfer.files[0]
    if (!f) return
    setScoreFile(f)
    runOcr(f)
  }

  function handleScoreFile(e) {
    const f = e.target.files[0]
    if (!f) return
    setScoreFile(f)
    runOcr(f)
  }

  const [videoError, setVideoError] = useState('')

  async function applyVideoFile(f) {
    if (!f) return
    setVideoError('')
    if (f.size > 500 * 1024 * 1024) {
      setVideoError(`File is ${Math.round(f.size / 1024 / 1024)} MB — please trim or compress to under 500 MB.`)
      return
    }
    const duration = await new Promise(resolve => {
      const v = document.createElement('video')
      v.preload = 'metadata'
      const url = URL.createObjectURL(f)
      v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(v.duration) }
      v.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
      v.src = url
    })
    setFile(f)
  }

  function handleVideoDrop(e) {
    e.preventDefault()
    setVideoDrag(false)
    applyVideoFile(e.dataTransfer.files[0])
  }

  function handleVideoFile(e) {
    applyVideoFile(e.target.files[0])
  }

  // ── Frame extraction for Mediant analysis ──────────────

  function extractVideoFrames(videoFile, count = 5) {
    return new Promise((resolve) => {
      const video = document.createElement('video')
      const objectURL = URL.createObjectURL(videoFile)
      video.src = objectURL
      video.muted = true
      video.preload = 'metadata'

      video.addEventListener('error', () => {
        URL.revokeObjectURL(objectURL)
        resolve([])
      })

      video.addEventListener('loadedmetadata', () => {
        const duration = video.duration
        if (!duration || !isFinite(duration) || video.videoWidth === 0) {
          URL.revokeObjectURL(objectURL)
          resolve([])
          return
        }

        const timestamps = Array.from({ length: count }, (_, i) =>
          parseFloat(((i / (count - 1)) * duration).toFixed(1))
        )
        const frames = []
        let index = 0

        function seekNext() {
          if (index >= timestamps.length) {
            URL.revokeObjectURL(objectURL)
            resolve(frames)
            return
          }
          video.currentTime = timestamps[index]
        }

        video.addEventListener('seeked', () => {
          try {
            const scale = Math.min(1, 640 / video.videoWidth)
            const canvas = document.createElement('canvas')
            canvas.width  = Math.round(video.videoWidth  * scale)
            canvas.height = Math.round(video.videoHeight * scale)
            const ctx = canvas.getContext('2d')
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            const dataURL = canvas.toDataURL('image/jpeg', 0.65)
            frames.push({ base64: dataURL.split(',')[1], timestamp: timestamps[index] })
          } catch { /* skip malformed frame */ }
          index++
          seekNext()
        })

        seekNext()
      })
    })
  }

  // ── Submit ────────────────────────────────────────────────────

  async function handleSubmit() {
    if (!readyToAnalyze) return
    if (!user?.id) {
      setErrorMsg('You must be logged in to analyze a recording.')
      setPhase('error')
      return
    }

    setPhase('uploading')
    setProgress(0)
    setErrorMsg('')
    setErrorDetails([])

    try {
      // Tick upload progress
      const progressTick = setInterval(() => {
        setProgress(p => Math.min(p + 6, 45))
      }, 300)

      // Upload video
      const safeName   = file.name.replace(/[^a-zA-Z0-9._-]/g, '-')
      const filePath   = `${user.id}/${Date.now()}-${safeName}`
      const { error: uploadError } = await supabase.storage
        .from('recordings')
        .upload(filePath, file, { contentType: file.type || 'video/mp4', upsert: false })

      // Upload sheet music (any type)
      let scorePath = undefined
      if (scoreFile) {
        const safeSN = scoreFile.name.replace(/[^a-zA-Z0-9._-]/g, '-')
        const sp = `${user.id}/scores/${Date.now()}-${safeSN}`
        const { error: scoreErr } = await supabase.storage
          .from('sheet-music')
          .upload(sp, scoreFile, { contentType: scoreFile.type || 'application/octet-stream', upsert: false })
        if (scoreErr) throw new Error(`Sheet music upload failed: ${scoreErr.message}`)
        scorePath = sp
      }

      clearInterval(progressTick)
      if (uploadError) throw new Error(uploadError.message || 'Upload failed')

      // Analyzing phase — extract frames then dispatch job
      setProgress(50)
      setPhase('analyzing')

      // Extract video frames for Mediant analysis (best-effort, non-fatal)
      let videoFrames = []
      try {
        videoFrames = await extractVideoFrames(file)
      } catch { /* skip if extraction fails */ }

      const { data: jobResult, error: fnError } = await supabase.functions.invoke('analyze-performance', {
        body: {
          videoPath:      filePath,
          videoMimeType:  file.type || 'video/mp4',
          scorePath,
          scoreMimeType:  scoreFile?.type || null,
          pieceTitle:     pieceTitle.trim() || undefined,
          composer:       composer.trim() || undefined,
          instrument,
          part:           part.trim() || undefined,
          timeSig:        timeSig.trim() || '4/4',
          keySignature:   keySignature.trim() || undefined,
          startMeasure:   startMeasure || undefined,
          endMeasure:     endMeasure || undefined,
          videoFrames:    videoFrames.length > 0 ? videoFrames : undefined,
        },
      })

      if (fnError || jobResult?.error) {
        throw new Error(jobResult?.error || fnError?.message || 'Failed to start analysis')
      }

      const jobId = jobResult?.jobId
      if (!jobId) throw new Error('No job ID returned from analysis service')

      // Poll job-status every 4s until done or failed (max 4 min = 60 attempts)
      // If the function already completed inline it returns status:'done' — skip straight to polling
      const { data: { session } } = await supabase.auth.getSession()
      const token   = session?.access_token
      const fnBase  = supabase.supabaseUrl + '/functions/v1'
      const anonKey = supabase.supabaseKey

      let finalResult = null
      const alreadyDone = jobResult?.status === 'done'
      for (let attempt = 0; attempt < 60; attempt++) {
        if (!alreadyDone || attempt > 0) await new Promise(r => setTimeout(r, 4000))
        setProgress(p => Math.min(p + 0.75, 95))

        try {
          const resp = await fetch(
            `${fnBase}/job-status?takeId=${encodeURIComponent(jobId)}`,
            { headers: { Authorization: `Bearer ${token}`, apikey: anonKey } },
          )
          if (!resp.ok) continue
          const status = await resp.json()

          if (status.status === 'done') {
            finalResult = status
            break
          }
          if (status.status === 'failed') {
            throw new Error(status.error || 'Analysis failed on the server.')
          }
        } catch (pollErr) {
          // Re-throw real errors (not network blips)
          if (pollErr.message && !pollErr.message.includes('Failed to fetch')) throw pollErr
        }
      }

      if (!finalResult) throw new Error('Analysis timed out after 4 minutes. Please try a shorter recording.')

      const takeRecord = {
        id:               jobId,
        piece_title:      pieceTitle.trim() || 'Untitled',
        piece_composer:   composer.trim() || 'Unknown',
        score:            finalResult.score ?? null,
        flags:            [],
        video_path:       filePath,
        video_mime_type:  file.type || 'video/mp4',
        score_path:       scorePath,
        analysis_quality: finalResult.analysisQuality ?? null,
        analysis_backend: finalResult.analysisBackend ?? null,
        date:             new Date().toISOString(),
      }

      localStorage.setItem('mediant_last_take', JSON.stringify(takeRecord))

      try {
        const existing = JSON.parse(localStorage.getItem('mediant_takes') || '[]')
        localStorage.setItem('mediant_takes', JSON.stringify([takeRecord, ...existing]))
      } catch { /* ignore storage errors */ }

      setProgress(100)
      setTimeout(() => nav(`/analysis?takeId=${encodeURIComponent(jobId)}`), 400)

    } catch (err) {
      setErrorMsg(err.message ?? 'Something went wrong. Please try again.')
      setErrorDetails(Array.isArray(err.details) ? err.details : [])
      setPhase('error')
    }
  }

  // ── Loading screens ───────────────────────────────────────────

  if (phase === 'uploading' || phase === 'analyzing') {
    const title = phase === 'uploading'
      ? 'Uploading your files…'
      : 'Analyzing your performance…'
    const sub = phase === 'uploading'
      ? 'Sending your recording and sheet music to the server.'
      : 'Mediant is analyzing your performance — timing, dynamics, intonation, and technique. This takes 1–3 minutes.'

    return (
      <div className={styles.page}>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>♪</div>
          <h2 className={styles.analyzeTitle}>{title}</h2>
          <p className={styles.analyzeSub}>{sub}</p>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${progress}%`, transition: 'width 0.4s ease' }} />
          </div>
          <p className={styles.progressLabel}>{Math.round(progress)}%</p>
        </div>
      </div>
    )
  }

  // ── Form ──────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Upload Recording</p>
          <h1 className={styles.title}>Submit your take</h1>
        </div>
        <button
          className={styles.primaryBtn}
          onClick={handleSubmit}
          disabled={!readyToAnalyze || phase === 'error'}
        >
          Analyze recording →
        </button>
      </div>

      {phase === 'error' && (
        <div className={styles.errorBanner}>
          <strong>Analysis failed:</strong> {errorMsg}
          {errorDetails.length > 0 && (
            <ul className={styles.analysisNoticeList} style={{ marginTop: 10 }}>
              {errorDetails.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
          <button className={styles.errorRetry} onClick={() => setPhase('idle')}>Try again</button>
        </div>
      )}

      <div className={styles.recordLayout}>
        {/* Left column */}
        <div className={styles.recordLeft}>

          {/* ── Sheet music (required) ── */}
          <div className={styles.pieceForm}>
            <p className={styles.label}>
              Sheet music <span className={styles.requiredDot}>required</span>
            </p>

            <div
              className={`${styles.dropzone} ${scoreDrag ? styles.dropzoneActive : ''} ${scoreFile ? styles.dropzoneDone : ''}`}
              onDragOver={e => { e.preventDefault(); setScoreDrag(true) }}
              onDragLeave={() => setScoreDrag(false)}
              onDrop={handleScoreDrop}
              onClick={() => scoreInputRef.current?.click()}
            >
              <input
                ref={scoreInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf,.xml,.musicxml,.mxl"
                style={{ display: 'none' }}
                onChange={handleScoreFile}
              />
              {scoreFile ? (
                <>
                  <span className={styles.dropzoneCheck}>✓</span>
                  <strong>{scoreFile.name}</strong>
                  {ocrLoading
                    ? <span className={styles.dropzoneSub}>Reading sheet music…</span>
                    : <span className={styles.dropzoneSub}>Click to replace</span>
                  }
                </>
              ) : (
                <>
                  <span className={styles.dropzoneIcon}>♩</span>
                  <strong>Photo, PDF, or MusicXML</strong>
                  <span className={styles.dropzoneSub}>MusicXML/MXL gives the most accurate measure mapping. Photos and PDFs work but may have lower confidence.</span>
                </>
              )}
            </div>

            {/* Auto-filled piece info */}
            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>
                  Title
                  {ocrLoading && <span className={styles.ocrBadge}>reading…</span>}
                  {!ocrLoading && pieceTitle && <span className={styles.ocrBadge}>Auto-detected</span>}
                </label>
                <input
                  className={styles.formInput}
                  value={pieceTitle}
                  onChange={e => setPieceTitle(e.target.value)}
                  placeholder="Auto-filled from sheet music"
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>
                  Composer
                  {!ocrLoading && composer && <span className={styles.ocrBadge}>Auto-detected</span>}
                </label>
                <input
                  className={styles.formInput}
                  value={composer}
                  onChange={e => setComposer(e.target.value)}
                  placeholder="Auto-filled from sheet music"
                />
              </div>
            </div>

            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Instrument</label>
                <select
                  className={styles.formSelect}
                  value={instrument}
                  onChange={e => setInstrument(e.target.value)}
                >
                  <option value="" disabled>Select instrument…</option>
                  {INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
                </select>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>
                  Movement / part <span className={styles.formOptional}>(optional)</span>
                </label>
                <input
                  className={styles.formInput}
                  value={part}
                  onChange={e => setPart(e.target.value)}
                  placeholder="e.g. III. Passepied"
                />
              </div>
            </div>

            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Time signature</label>
                <input
                  className={styles.formInput}
                  value={timeSig}
                  onChange={e => setTimeSig(e.target.value)}
                  placeholder="4/4"
                />
                <span className={styles.formOptional} style={{ marginTop: 4, display: 'block' }}>
                  Used to keep measure numbers aligned.
                </span>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Key</label>
                <input
                  className={styles.formInput}
                  value={keySignature}
                  onChange={e => setKeySignature(e.target.value)}
                  placeholder="e.g. D minor, B♭ major"
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Starting measure</label>
                <input
                  className={styles.formInput}
                  type="number"
                  min="1"
                  value={startMeasure}
                  onChange={e => setStartMeasure(e.target.value)}
                  placeholder="1"
                />
                <span className={styles.formOptional} style={{ marginTop: 4, display: 'block' }}>
                  What measure does the recording begin on?
                </span>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>
                  Ending measure <span className={styles.formOptional}>(optional)</span>
                </label>
                <input
                  className={styles.formInput}
                  type="number"
                  min="1"
                  value={endMeasure}
                  onChange={e => setEndMeasure(e.target.value)}
                  placeholder="auto"
                />
                <span className={styles.formOptional} style={{ marginTop: 4, display: 'block' }}>
                  Last measure played. Prevents false flags beyond your excerpt.
                </span>
              </div>
            </div>
          </div>

          {/* ── Video recording (required) ── */}
          <div className={styles.pieceForm}>
            <p className={styles.label}>
              Recording <span className={styles.requiredDot}>required</span>
            </p>
            <div
              className={`${styles.dropzone} ${videoDrag ? styles.dropzoneActive : ''} ${file ? styles.dropzoneDone : ''}`}
              onDragOver={e => { e.preventDefault(); setVideoDrag(true) }}
              onDragLeave={() => setVideoDrag(false)}
              onDrop={handleVideoDrop}
              onClick={() => videoInputRef.current?.click()}
            >
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                style={{ display: 'none' }}
                onChange={handleVideoFile}
              />
              {file ? (
                <>
                  <span className={styles.dropzoneCheck}>✓</span>
                  <strong>{file.name}</strong>
                  <span className={styles.dropzoneSub}>Click to choose a different file</span>
                </>
              ) : (
                <>
                  <span className={styles.dropzoneIcon}>↑</span>
                  <strong>Drag a video here or click to upload</strong>
                  <span className={styles.dropzoneSub}>MP4, MOV, or WebM · under 5 minutes</span>
                </>
              )}
              {videoError && (
                <span className={styles.dropzoneSub} style={{ color: '#e05b5b', marginTop: 6 }}>{videoError}</span>
              )}
            </div>
          </div>

          {!scoreFile && (
            <p className={styles.formHint}>Upload a photo of your sheet music to get started.</p>
          )}
        </div>

        {/* Right column — status cards */}
        <div>
          <div className={styles.waveformCard}>
            <div className={styles.waveform}>
              {[22, 46, 62, 34, 78, 48, 70, 31, 64, 52, 38, 68].map((h, i) => (
                <span key={i} style={{ height: `${h}%`, opacity: file ? 1 : 0.35 }} />
              ))}
            </div>
            <p className={styles.resultSub}>
              {file ? `${file.name} · ready for review` : 'No recording loaded yet'}
            </p>
          </div>

          <div className={styles.captureGrid}>
            <div className={styles.captureCard}>
              <p className={styles.label}>What Mediant sees</p>
              <strong>Sheet music · Measure structure · Notation</strong>
            </div>
            <div className={styles.captureCard}>
              <p className={styles.label}>What Mediant listens for</p>
              <strong>Timing · Dynamics · Articulation · Intonation</strong>
            </div>
          </div>
        </div>
      </div>

      <button
        className={`${styles.primaryBtn} ${styles.submitBtn}`}
        onClick={handleSubmit}
        disabled={!readyToAnalyze || phase === 'error'}
      >
        Analyze recording →
      </button>
    </div>
  )
}
