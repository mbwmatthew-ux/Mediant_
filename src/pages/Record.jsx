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
        const { pieceTitle: t, composer: c, instrument: ins, pieceId } = JSON.parse(raw)
        if (t)   setPieceTitle(t)
        if (c)   setComposer(c)
        if (ins && INSTRUMENTS.includes(ins)) setInstrument(ins)
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
      const buf    = await f.arrayBuffer()
      const b64    = btoa(String.fromCharCode(...new Uint8Array(buf)))
      const res    = await fetch('/api/analyze-sheet-music', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageBase64: b64, mediaType: f.type }),
      })
      const data = await res.json()
      if (data.title)    setPieceTitle(data.title)
      if (data.composer) setComposer(data.composer)
      if (data.time)     setTimeSig(data.time)
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
    if (duration && duration > 100) {
      setVideoError(`Recording is ${Math.round(duration)}s — please trim to under 100 seconds. Aim for 30–60s for best results.`)
      return
    }
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

      // Analyzing phase
      setProgress(50)
      setPhase('analyzing')
      const analysisTick = setInterval(() => {
        setProgress(p => Math.min(p + 2, 95))
      }, 800)

      const { data: result, error: fnError } = await supabase.functions.invoke('analyze-performance', {
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
          startMeasure:   startMeasure || undefined,
          endMeasure:     endMeasure || undefined,
        },
      })

      clearInterval(analysisTick)

      if (fnError || result?.error) {
        // Try to extract the real error body from the Edge Function response
        let realError = result?.error || fnError?.message || 'Analysis failed'
        let realDetails = Array.isArray(result?.analysisQuality?.reasons)
          ? result.analysisQuality.reasons
          : Array.isArray(result?.suggestions)
            ? result.suggestions
            : []
        try {
          if (fnError?.context) {
            const rawText = await fnError.context.text()
            if (rawText) {
              try {
                const body = JSON.parse(rawText)
                if (body?.error) realError = body.error
                if (Array.isArray(body?.analysisQuality?.reasons)) {
                  realDetails = body.analysisQuality.reasons
                } else if (Array.isArray(body?.suggestions)) {
                  realDetails = body.suggestions
                }
              } catch {
                realError = rawText
              }
            }
          }
        } catch { /* ignore */ }
        const error = new Error(realError)
        error.details = realDetails
        throw error
      }

      const takeRecord = {
        id:              result.takeId ?? `local-${Date.now()}`,
        piece_title:     pieceTitle.trim() || 'Untitled',
        piece_composer:  composer.trim() || 'Unknown',
        score:           result.score,
        flags:           result.flags,
        video_path:      filePath,
        video_mime_type: file.type || 'video/mp4',
        score_path:      scorePath,
        analysis_quality: result.analysisQuality ?? null,
        analysis_backend: result.analysisBackend ?? null,
        date:            new Date().toISOString(),
      }

      localStorage.setItem('mediant_last_take', JSON.stringify(takeRecord))

      // Append to per-piece history so the library panel can show past sessions
      try {
        const existing = JSON.parse(localStorage.getItem('mediant_takes') || '[]')
        localStorage.setItem('mediant_takes', JSON.stringify([takeRecord, ...existing]))
      } catch { /* ignore storage errors */ }

      setProgress(100)
      setTimeout(() => {
        nav(result.takeId ? `/analysis?takeId=${encodeURIComponent(result.takeId)}` : '/analysis')
      }, 400)

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
      : 'Gemini is analyzing timing, dynamics, and technique. This takes about 30 seconds.'

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
                  <span className={styles.dropzoneSub}>MusicXML/MXL is most accurate; clean PDFs/photos are converted first</span>
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
                  <span className={styles.dropzoneSub}>MP4, MOV, or WebM · under 60 seconds</span>
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
