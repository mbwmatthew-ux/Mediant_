import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { extractAudioFeatures, extractScoreFacts } from '../lib/analysisEvidence'
import styles from './NewRecordingModal.module.css'
import { playDrop, playAnalyzeStart, playAnalyzeComplete } from '../utils/sounds'

const TAG_OPTIONS = ['Piece', 'Warm-up', 'Sight-read']

/* Extract sampled video frames for the analysis engine (best-effort, non-fatal). */
function extractVideoFrames(videoFile, count = 9) {
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
      const sampleCount = Math.max(3, count)
      const start = Math.min(duration * 0.08, 2)
      const end = Math.max(start + 0.1, duration - Math.min(duration * 0.08, 2))
      const timestamps = Array.from({ length: sampleCount }, (_, i) => {
        const ratio = sampleCount === 1 ? 0.5 : i / (sampleCount - 1)
        return parseFloat((start + ratio * (end - start)).toFixed(1))
      })
      const frames = []
      let index = 0
      let seekTimer = null

      function cleanup() {
        if (seekTimer) clearTimeout(seekTimer)
        URL.revokeObjectURL(objectURL)
      }
      function seekNext() {
        if (index >= timestamps.length) { cleanup(); resolve(frames); return }
        if (seekTimer) clearTimeout(seekTimer)
        seekTimer = setTimeout(() => { index++; seekNext() }, 2500)
        video.currentTime = timestamps[index]
      }
      video.addEventListener('seeked', () => {
        if (seekTimer) clearTimeout(seekTimer)
        try {
          const scale = Math.min(1, 720 / video.videoWidth)
          const canvas = document.createElement('canvas')
          canvas.width  = Math.round(video.videoWidth  * scale)
          canvas.height = Math.round(video.videoHeight * scale)
          const ctx = canvas.getContext('2d')
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const dataURL = canvas.toDataURL('image/jpeg', 0.72)
          frames.push({ base64: dataURL.split(',')[1], timestamp: timestamps[index] })
        } catch { /* skip malformed frame */ }
        index++
        seekNext()
      })
      seekNext()
    })
  })
}

export default function NewRecordingModal({ open, onClose }) {
  const nav = useNavigate()
  const { user } = useAuth()

  const [pieceName, setPieceName] = useState('')
  const [tag, setTag] = useState('Piece')

  // Performance: one of video OR audio required
  const [videoFile, setVideoFile] = useState(null)
  const [audioFile, setAudioFile] = useState(null)
  const [scoreFile, setScoreFile] = useState(null)

  const videoInputRef = useRef()
  const audioInputRef = useRef()
  const scoreInputRef = useRef()

  const [phase, setPhase] = useState('idle') // idle | uploading | analyzing | error
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')

  const performanceFile = videoFile || audioFile
  const readyToAnalyze = Boolean(performanceFile)

  // Reset when closed
  useEffect(() => {
    if (!open) {
      setPhase('idle'); setProgress(0); setErrorMsg('')
    }
  }, [open])

  // Close on Escape (unless mid-analysis)
  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape' && phase !== 'uploading' && phase !== 'analyzing') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, phase, onClose])

  if (!open) return null

  function pickVideo(e) {
    const f = e.target.files?.[0]
    if (f) { playDrop(); setVideoFile(f); setAudioFile(null) }
  }
  function pickAudio(e) {
    const f = e.target.files?.[0]
    if (f) { playDrop(); setAudioFile(f); setVideoFile(null) }
  }
  function pickScore(e) {
    const f = e.target.files?.[0]
    if (f) { playDrop(); setScoreFile(f) }
  }

  async function handleSubmit() {
    if (!readyToAnalyze) return
    if (!user?.id) {
      setErrorMsg('You must be logged in to analyze a recording.')
      setPhase('error')
      return
    }

    const media = performanceFile
    playAnalyzeStart()
    setPhase('uploading')
    setProgress(0)
    setErrorMsg('')

    try {
      const progressTick = setInterval(() => setProgress(p => Math.min(p + 6, 45)), 300)

      // Upload performance media
      const safeName = media.name.replace(/[^a-zA-Z0-9._-]/g, '-')
      const filePath = `${user.id}/${Date.now()}-${safeName}`
      const { error: uploadError } = await supabase.storage
        .from('recordings')
        .upload(filePath, media, { contentType: media.type || 'video/mp4', upsert: false })

      // Upload sheet music (optional)
      let scorePath
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
      if (uploadError) throw new Error(`Upload failed: ${uploadError.message || 'please try a different file'}`)

      setProgress(50)
      setPhase('analyzing')

      // Skip all client-side evidence extraction — keep the request body tiny to
      // avoid Cloudflare dropping the connection. The edge function reads files
      // directly from storage.
      const videoFrames = []
      const scoreFacts = null
      const audioFeatures = null

      const { data: { session: freshSession } } = await supabase.auth.getSession()
      if (!freshSession) throw new Error('Your session has expired. Please log in again.')

      const fnUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-performance`
      console.log('[mediant] analysis fetch →', fnUrl)
      let fnResp
      try {
        fnResp = await fetch(fnUrl, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${freshSession.access_token}`,
            'apikey':        import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            videoPath:     filePath,
            videoMimeType: media.type || (videoFile ? 'video/mp4' : 'audio/mpeg'),
            scorePath:     scorePath || undefined,
            scoreMimeType: scoreFile?.type || undefined,
            pieceTitle:    pieceName.trim() || undefined,
            timeSig:       '4/4',
            notes:         tag && tag !== 'Piece' ? `Session type: ${tag}.` : undefined,
          }),
        })
      } catch (networkErr) {
        throw new Error(`Network error [${fnUrl}]: ${networkErr.message}`)
      }
      if (!fnResp.ok) {
        let msg = `Analysis service returned ${fnResp.status}`
        try { const b = await fnResp.json(); if (b?.error) msg = b.error } catch { /* keep */ }
        throw new Error(msg)
      }
      const jobResult = await fnResp.json()
      if (jobResult?.error) throw new Error(jobResult.error)

      const jobId = jobResult?.jobId
      if (!jobId) throw new Error('No job ID returned from analysis service')

      const { data: { session } } = await supabase.auth.getSession()
      const token  = session?.access_token
      const fnBase = supabase.supabaseUrl + '/functions/v1'

      let finalResult = null
      const alreadyDone = jobResult?.status === 'done'
      for (let attempt = 0; attempt < 60; attempt++) {
        if (!alreadyDone || attempt > 0) await new Promise(r => setTimeout(r, 4000))
        setProgress(p => Math.min(p + 0.75, 95))
        try {
          const resp = await fetch(
            `${fnBase}/job-status?takeId=${encodeURIComponent(jobId)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
          if (!resp.ok) continue
          const status = await resp.json()
          if (status.status === 'done') { finalResult = status; break }
          if (status.status === 'failed') throw new Error(status.error || 'Analysis failed on the server.')
        } catch (pollErr) {
          if (pollErr.message && !pollErr.message.includes('Failed to fetch')) throw pollErr
        }
      }

      if (!finalResult) throw new Error('Analysis timed out. Please try a shorter recording.')

      const takeRecord = {
        id:              jobId,
        piece_title:     pieceName.trim() || 'Untitled',
        piece_composer:  'Unknown',
        score:           finalResult.score ?? null,
        flags:           finalResult.flags ?? [],
        video_path:      filePath,
        video_mime_type: media.type || 'video/mp4',
        score_path:      scorePath,
        analysis_quality: finalResult.analysisQuality ?? null,
        analysis_backend: finalResult.analysisBackend ?? null,
        date:            new Date().toISOString(),
      }
      localStorage.setItem('mediant_last_take', JSON.stringify(takeRecord))
      try {
        const existing = JSON.parse(localStorage.getItem('mediant_takes') || '[]')
        localStorage.setItem('mediant_takes', JSON.stringify([takeRecord, ...existing]))
      } catch { /* ignore */ }

      setProgress(100)
      playAnalyzeComplete()
      setTimeout(() => {
        onClose?.()
        nav(`/analysis?takeId=${encodeURIComponent(jobId)}`)
      }, 600)
    } catch (err) {
      setErrorMsg(err.message ?? 'Something went wrong. Please try again.')
      setPhase('error')
    }
  }

  const busy = phase === 'uploading' || phase === 'analyzing'

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="New recording">
      <button className={styles.backdrop} onClick={() => !busy && onClose?.()} aria-label="Close" />
      <div className={styles.modal}>
        {busy ? (
          <div className={styles.analyzeScreen}>
            <div className={styles.analyzeIcon}>♪</div>
            <h2 className={styles.analyzeTitle}>
              {phase === 'uploading' ? 'Uploading your files…' : 'Analyzing your performance…'}
            </h2>
            <p className={styles.analyzeSub}>
              {phase === 'uploading'
                ? 'Sending your recording to the server.'
                : 'Mediant is listening for timing, dynamics, intonation, and technique.'}
            </p>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
            <p className={styles.progressLabel}>{Math.round(progress)}%</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className={styles.header}>
              <div className={styles.headerIcon}><MicIcon /></div>
              <div>
                <h2 className={styles.title}>New recording</h2>
                <p className={styles.subtitle}>Upload your performance and Mediant will return bar-by-bar feedback.</p>
              </div>
              <button className={styles.closeBtn} onClick={() => onClose?.()} aria-label="Close">×</button>
            </div>

            <div className={styles.body}>
              {phase === 'error' && (
                <div className={styles.errorBanner}>
                  <strong>Analysis failed:</strong> {errorMsg}
                  <button className={styles.retryBtn} onClick={() => setPhase('idle')}>Try again</button>
                </div>
              )}

              {/* Piece name + tags */}
              <label className={styles.fieldLabel}>Piece name</label>
              <input
                className={styles.textInput}
                value={pieceName}
                onChange={e => setPieceName(e.target.value)}
                placeholder="e.g. Clair de lune"
              />
              <div className={styles.tagRow}>
                {TAG_OPTIONS.map(t => (
                  <button
                    key={t}
                    type="button"
                    className={`${styles.tagPill} ${tag === t ? styles.tagPillActive : ''}`}
                    onClick={() => setTag(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Performance */}
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>Your performance</span>
                <span className={styles.reqBadge}>REQUIRED</span>
              </div>
              <div className={styles.uploadRow}>
                <UploadCard
                  active={!!videoFile}
                  icon={<VideoIcon />}
                  title={videoFile ? videoFile.name : 'Video'}
                  hint="MP4, MOV up to 500MB"
                  onClick={() => videoInputRef.current?.click()}
                />
                <UploadCard
                  active={!!audioFile}
                  icon={<AudioIcon />}
                  title={audioFile ? audioFile.name : 'Audio'}
                  hint="WAV, MP3, M4A up to 200MB"
                  onClick={() => audioInputRef.current?.click()}
                />
              </div>
              <input ref={videoInputRef} type="file" accept="video/*" hidden onChange={pickVideo} />
              <input ref={audioInputRef} type="file" accept="audio/*" hidden onChange={pickAudio} />

              {/* Sheet music */}
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>Sheet music</span>
                <span className={styles.optBadge}>OPTIONAL BUT RECOMMENDED</span>
              </div>
              <UploadCard
                wide
                active={!!scoreFile}
                icon={<ScoreIcon />}
                title={scoreFile ? scoreFile.name : 'Photo of score'}
                hint="JPG, PNG, or PDF"
                onClick={() => scoreInputRef.current?.click()}
              />
              <input
                ref={scoreInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                hidden
                onChange={pickScore}
              />
              <p className={styles.infoNote}>
                A clear photo lets Mediant pin issues to specific measures on your score.
              </p>
            </div>

            {/* Footer */}
            <div className={styles.footer}>
              <span className={styles.footerNote}>Analysis usually takes 30–60 seconds.</span>
              <div className={styles.footerActions}>
                <button className={styles.cancelBtn} onClick={() => onClose?.()}>Cancel</button>
                <button className={styles.analyzeBtn} onClick={handleSubmit} disabled={!readyToAnalyze}>
                  Analyze
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function UploadCard({ active, icon, title, hint, onClick, wide }) {
  return (
    <button
      type="button"
      className={`${styles.uploadCard} ${wide ? styles.uploadCardWide : ''} ${active ? styles.uploadCardActive : ''}`}
      onClick={onClick}
    >
      <span className={styles.uploadIcon}>{active ? <CheckIcon /> : icon}</span>
      <span className={styles.uploadTitle}>{title}</span>
      <span className={styles.uploadHint}>{active ? 'Click to replace' : hint}</span>
    </button>
  )
}

/* ── Icons ── */
function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  )
}
function VideoIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
    </svg>
  )
}
function AudioIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
  )
}
function ScoreIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}
