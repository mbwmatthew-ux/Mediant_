import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './Page.module.css'

export default function Record() {
  const nav = useNavigate()
  const [file, setFile]         = useState(null)
  const [dragging, setDragging] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState(0)
  const inputRef = useRef()

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) setFile(f)
  }

  function handleFile(e) {
    const f = e.target.files[0]
    if (f) setFile(f)
  }

  function handleSubmit() {
    setAnalyzing(true)
    setProgress(0)
    // Simulate analysis progress
    let p = 0
    const tick = setInterval(() => {
      p += Math.random() * 14
      setProgress(Math.min(p, 99))
      if (p >= 99) {
        clearInterval(tick)
        setTimeout(() => nav('/analysis'), 600)
      }
    }, 200)
  }

  if (analyzing) {
    return (
      <div className={styles.page}>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>♪</div>
          <h2 className={styles.analyzeTitle}>Analyzing your performance…</h2>
          <p className={styles.analyzeSub}>Matching to score, identifying part, flagging moments.</p>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
          </div>
          <p className={styles.progressLabel}>{Math.round(progress)}%</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Upload Recording</p>
          <h1 className={styles.title}>Submit your take</h1>
        </div>
        {file && (
          <button className={styles.primaryBtn} onClick={handleSubmit}>
            Analyze recording →
          </button>
        )}
      </div>

      <div className={styles.recordLayout}>
        <div>
          <div className={styles.pieceCard}>
            <p className={styles.label}>Selected piece</p>
            <h3 className={styles.resultTitle}>Clair de Lune</h3>
            <p className={styles.resultSub}>Solo piano · the app will infer your part automatically.</p>
          </div>

          <div
            className={`${styles.dropzone} ${dragging ? styles.dropzoneActive : ''} ${file ? styles.dropzoneDone : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
          >
            <input ref={inputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleFile} />
            {file ? (
              <>
                <span className={styles.dropzoneCheck}>✓</span>
                <strong>{file.name}</strong>
                <span className={styles.dropzoneSub}>Click to choose a different file</span>
              </>
            ) : (
              <>
                <span className={styles.dropzoneIcon}>↑</span>
                <strong>Drag a recording here or click to upload</strong>
                <span className={styles.dropzoneSub}>WAV, MP3, AIFF, or M4A</span>
              </>
            )}
          </div>
        </div>

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
              <p className={styles.label}>Detected setup</p>
              <strong>Piano · indoor room · solo part</strong>
            </div>
            <div className={styles.captureCard}>
              <p className={styles.label}>Expected output</p>
              <strong>Generated notation + flagged measures</strong>
            </div>
          </div>
        </div>
      </div>

      {file && (
        <button className={`${styles.primaryBtn} ${styles.submitBtn}`} onClick={handleSubmit}>
          Analyze recording →
        </button>
      )}
    </div>
  )
}
