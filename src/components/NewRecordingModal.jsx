import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { extractAudioFeatures, extractScoreFacts } from '../lib/analysisEvidence'
import styles from './NewRecordingModal.module.css'
import { playDrop, playTick, playAnalyzeStart, playAnalyzeComplete } from '../utils/sounds'
import { searchInstruments } from '../lib/instruments'


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
  const [startMeasure, setStartMeasure] = useState('')
  const [endMeasure, setEndMeasure] = useState('')
  const [timeSig, setTimeSig] = useState('4/4')
  const [instrument, setInstrument] = useState('')
  const [instQuery, setInstQuery] = useState('')
  const [instOpen, setInstOpen] = useState(false)
  const [instHi, setInstHi] = useState(0)
  const instBoxRef = useRef(null)

  // Performance: one of video OR audio required
  const [videoFile, setVideoFile] = useState(null)
  const [audioFile, setAudioFile] = useState(null)
  const [scoreFiles, setScoreFiles] = useState([]) // multiple pages; page 0 is what the AI actually analyzes today

  const videoInputRef = useRef()
  const audioInputRef = useRef()
  const scoreInputRef = useRef()

  const [phase, setPhase] = useState('idle') // idle | uploading | analyzing | error
  const [progress, setProgress] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')

  const performanceFile = videoFile || audioFile
  // Everything is required now: a performance (video OR audio) AND at least one
  // sheet-music page. The score used to be optional-but-recommended.
  const readyToAnalyze = Boolean(performanceFile) && scoreFiles.length > 0 && Boolean(instrument.trim())

  // Reset when closed
  useEffect(() => {
    if (!open) {
      setPhase('idle'); setProgress(0); setErrorMsg('')
    }
  }, [open])

  // Close the instrument dropdown when clicking elsewhere
  useEffect(() => {
    if (!instOpen) return
    function onDown(e) {
      if (instBoxRef.current && !instBoxRef.current.contains(e.target)) setInstOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [instOpen])

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
    const files = Array.from(e.target.files ?? [])
    if (files.length) { playDrop(); setScoreFiles(prev => [...prev, ...files]) }
    e.target.value = '' // allow re-picking the same file(s) / adding more after removing one
  }
  function removeScorePage(idx) {
    playTick()
    setScoreFiles(prev => prev.filter((_, i) => i !== idx))
  }
  function clearVideo() {
    playTick()
    setVideoFile(null)
    // Clear the input's value too, or re-picking the SAME file fires no change event.
    if (videoInputRef.current) videoInputRef.current.value = ''
  }
  function clearAudio() {
    playTick()
    setAudioFile(null)
    if (audioInputRef.current) audioInputRef.current.value = ''
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

      // Upload sheet music pages (optional, multiple allowed). Only the FIRST page
      // (scorePath, kept singular for backward compat) is actually read by the AI
      // today — the rest are stored and viewable on the Analysis page but not yet
      // fed into measure detection.
      let scorePath
      const scorePaths = []
      for (const file of scoreFiles) {
        const safeSN = file.name.replace(/[^a-zA-Z0-9._-]/g, '-')
        // Name the object by its CONTENT hash, not Date.now(). The analysis
        // pipeline caches its (slow, expensive, AI-vision) score parse in
        // score_cache keyed on this path — with a timestamp in the name, the
        // same photo got a new path every upload, so the cache could never hit
        // and every run re-read the page from scratch. Those re-reads are not
        // identical: the same image yielded 54 / 64 / 68 measures and a 2/4 vs
        // 3/4 time signature on different runs, and each wrong value flows
        // straight into measure numbering. Hashing makes an identical photo
        // reuse one parse — consistent measure numbers, and no repeat cost.
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
        const hash = Array.from(new Uint8Array(digest))
          .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
        const sp = `${user.id}/scores/${hash}-${safeSN}`
        const { error: scoreErr } = await supabase.storage
          .from('sheet-music')
          .upload(sp, file, { contentType: file.type || 'application/octet-stream', upsert: false })
        // A collision here is expected and benign: the path IS the file's content
        // hash, so an object already sitting there is byte-identical and there is
        // nothing to re-upload. Deliberately NOT `upsert: true` — that issues an
        // UPDATE, and the storage policies grant INSERT/SELECT/DELETE only, so it
        // failed RLS ("new row violates row-level security policy") the moment the
        // same photo was uploaded twice.
        const isDuplicate = scoreErr && (
          scoreErr.statusCode === '409' || scoreErr.statusCode === 409 ||
          /already exists|duplicate|resource already/i.test(scoreErr.message || '')
        )
        if (scoreErr && !isDuplicate) throw new Error(`Sheet music upload failed: ${scoreErr.message}`)
        scorePaths.push(sp)
      }
      if (scorePaths.length) scorePath = scorePaths[0]

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
            scorePaths:    scorePaths.length ? scorePaths : undefined,
            scoreMimeType: scoreFiles[0]?.type || undefined,
            instrument:    instrument.trim(),
            pieceTitle:    pieceName.trim() || undefined,
            timeSig:       timeSig.trim() || '4/4',
            startMeasure:  startMeasure ? parseInt(startMeasure, 10) : 1,
            endMeasure:    endMeasure ? parseInt(endMeasure, 10) : undefined,
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
      for (let attempt = 0; attempt < 120; attempt++) {
        if (!alreadyDone || attempt > 0) await new Promise(r => setTimeout(r, 5000))
        setProgress(p => Math.min(p + 0.37, 95))
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

      if (!finalResult) throw new Error('Analysis is taking longer than expected. Please check back in a moment — your results will appear in your session history when ready.')

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
              {/* Instrument — required. Without it the analysis cannot know the
                  part is transposing, and a correctly-played B-flat clarinet
                  reads as a page full of wrong notes. */}
              <div className={styles.instrumentRow} ref={instBoxRef}>
                <label className={styles.fieldLabel} htmlFor="instrument-input">Instrument</label>
                <div className={styles.comboWrap}>
                  <input
                    id="instrument-input"
                    className={styles.textInput}
                    value={instQuery || instrument}
                    placeholder="Start typing — e.g. clarinet, sax, violin"
                    autoComplete="off"
                    role="combobox"
                    aria-expanded={instOpen}
                    aria-controls="instrument-listbox"
                    aria-autocomplete="list"
                    onChange={e => {
                      setInstQuery(e.target.value)
                      setInstrument('')
                      setInstOpen(true)
                      setInstHi(0)
                    }}
                    onFocus={() => setInstOpen(true)}
                    onKeyDown={e => {
                      const list = searchInstruments(instQuery || instrument)
                      if (e.key === 'ArrowDown') {
                        e.preventDefault(); setInstOpen(true)
                        setInstHi(h => Math.min(h + 1, Math.max(0, list.length - 1)))
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault(); setInstHi(h => Math.max(0, h - 1))
                      } else if (e.key === 'Enter' && instOpen && list[instHi]) {
                        e.preventDefault()
                        playTick()
                        setInstrument(list[instHi].name); setInstQuery(''); setInstOpen(false)
                      } else if (e.key === 'Escape') {
                        setInstOpen(false)
                      }
                    }}
                  />
                  {instrument && !instOpen && <span className={styles.comboCheck}><CheckIcon /></span>}
                  {instOpen && (() => {
                    const list = searchInstruments(instQuery || instrument)
                    if (!list.length) {
                      return (
                        <ul className={styles.comboList} id="instrument-listbox" role="listbox">
                          <li className={styles.comboEmpty}>
                            No match — you can still type your instrument in full
                          </li>
                        </ul>
                      )
                    }
                    return (
                      <ul className={styles.comboList} id="instrument-listbox" role="listbox">
                        {list.map((inst, i) => (
                          <li
                            key={inst.name}
                            role="option"
                            aria-selected={i === instHi}
                            className={`${styles.comboItem} ${i === instHi ? styles.comboItemActive : ''}`}
                            onMouseEnter={() => setInstHi(i)}
                            onMouseDown={e => {
                              e.preventDefault()
                              playTick()
                              setInstrument(inst.name); setInstQuery(''); setInstOpen(false)
                            }}
                          >
                            <span className={styles.comboName}>{inst.name}</span>
                            <span className={styles.comboFamily}>{inst.family}</span>
                          </li>
                        ))}
                      </ul>
                    )
                  })()}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className={styles.fieldLabel}>Piece name</label>
                  <input
                    className={styles.textInput}
                    value={pieceName}
                    onChange={e => setPieceName(e.target.value)}
                    placeholder="e.g. Clair de lune"
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>Start measure</label>
                  <input
                    className={styles.textInput}
                    type="number"
                    min="1"
                    value={startMeasure}
                    onChange={e => setStartMeasure(e.target.value)}
                    placeholder="1"
                    style={{ textAlign: 'center' }}
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>End measure</label>
                  <input
                    className={styles.textInput}
                    type="number"
                    min="1"
                    value={endMeasure}
                    onChange={e => setEndMeasure(e.target.value)}
                    placeholder="last"
                    style={{ textAlign: 'center' }}
                  />
                </div>
                <div style={{ width: 90 }}>
                  <label className={styles.fieldLabel}>Time sig.</label>
                  <input
                    className={styles.textInput}
                    value={timeSig}
                    onChange={e => setTimeSig(e.target.value)}
                    placeholder="4/4"
                    style={{ textAlign: 'center' }}
                    title="Only needed if the sheet music's time signature isn't read correctly from the score image"
                  />
                </div>
              </div>
              {/* Performance */}
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>Your performance</span>
              </div>
              <div className={styles.uploadRow}>
                <UploadCard
                  active={!!videoFile}
                  icon={<VideoIcon />}
                  title={videoFile ? videoFile.name : 'Video'}
                  hint="MP4, MOV up to 500MB"
                  onClick={() => videoInputRef.current?.click()}
                  onRemove={videoFile ? clearVideo : undefined}
                />
                <UploadCard
                  active={!!audioFile}
                  icon={<AudioIcon />}
                  title={audioFile ? audioFile.name : 'Audio'}
                  hint="WAV, MP3, M4A up to 200MB"
                  onClick={() => audioInputRef.current?.click()}
                  onRemove={audioFile ? clearAudio : undefined}
                />
              </div>
              <input ref={videoInputRef} type="file" accept="video/*" hidden onChange={pickVideo} />
              <input ref={audioInputRef} type="file" accept="audio/*" hidden onChange={pickAudio} />

              {/* Sheet music — multiple pages allowed. Only the first page is read by
                  the AI today; the rest are stored and viewable on the Analysis page. */}
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>Sheet music</span>
              </div>
              <UploadCard
                wide
                active={scoreFiles.length > 0}
                icon={<ScoreIcon />}
                title={scoreFiles.length === 0
                  ? 'Add sheet music'
                  : `Add another page (${scoreFiles.length} added)`}
                hint="JPG, PNG, or PDF — add as many pages as you need"
                activeHint="Click to add another page"
                onClick={() => scoreInputRef.current?.click()}
              />
              <input
                ref={scoreInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                multiple
                hidden
                onChange={pickScore}
              />
              {/* One row per page, each independently removable — the card above
                  always ADDS, so a mis-picked page is deleted here rather than by
                  replacing the whole selection. */}
              {scoreFiles.length > 0 && (
                <ul className={styles.pageList}>
                  {scoreFiles.map((f, i) => (
                    <li key={`${f.name}-${f.lastModified}-${i}`} className={styles.pageRow}>
                      <span className={styles.pageNum}>{i + 1}</span>
                      <span className={styles.pageName} title={f.name}>{f.name}</span>
                      <button
                        type="button"
                        className={styles.pageRemove}
                        aria-label={`Remove page ${i + 1}`}
                        title="Remove"
                        onClick={() => removeScorePage(i)}
                      >
                        <TrashIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
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

/* `onRemove` is optional. When given, a small remove control is layered over the
   card — it's a <span role="button"> rather than a <button> because the card
   itself is already a <button>, and nesting interactive elements is invalid
   HTML (React will warn, and browsers recover unpredictably). Clicks are
   stopped from bubbling so removing doesn't also re-open the file picker. */
function UploadCard({ active, icon, title, hint, onClick, wide, onRemove, activeHint }) {
  return (
    <button
      type="button"
      className={`${styles.uploadCard} ${wide ? styles.uploadCardWide : ''} ${active ? styles.uploadCardActive : ''}`}
      onClick={onClick}
    >
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          aria-label="Remove file"
          title="Remove"
          className={styles.cardRemove}
          onClick={e => { e.stopPropagation(); onRemove() }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove() }
          }}
        >
          <TrashIcon />
        </span>
      )}
      <span className={styles.uploadIcon}>{active ? <CheckIcon /> : icon}</span>
      <span className={styles.uploadTitle}>{title}</span>
      {/* The score card ADDS pages rather than replacing them, so it overrides
          the default "Click to replace" copy via activeHint. */}
      <span className={styles.uploadHint}>{active ? (activeHint ?? 'Click to replace') : hint}</span>
    </button>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
    </svg>
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
