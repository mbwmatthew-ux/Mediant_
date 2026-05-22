import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { supabase } from '../lib/supabase'
import styles from './Page.module.css'

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

function timeAgo(iso) {
  if (!iso) return null
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (diff < 60)   return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function trustLabel(level) {
  if (level === 'high') return 'High-trust analysis'
  if (level === 'medium') return 'Medium-trust analysis'
  if (level === 'low') return 'Low-trust analysis'
  return 'Analysis quality'
}

function trustTone(level) {
  if (level === 'high') return 'High'
  if (level === 'medium') return 'Medium'
  return 'Low'
}

// Maps a piece title to a bundled score file in /public/scores/
function scoreFileForPiece(title) {
  if (!title) return null
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const known = {
    'clair-de-lune': '/scores/clair-de-lune.mxl',
  }
  return known[slug] ?? null
}

// ── Component ─────────────────────────────────────────────────────────────

export default function Analysis() {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const scoreEl  = useRef(null)
  const osmdRef  = useRef(null)

  const videoRef    = useRef(null)
  const loopRef     = useRef(null)   // {start, end} for current excerpt loop

  const [take, setTake]               = useState(undefined)
  const [scoreUrl, setScoreUrl]       = useState(null)
  const [videoUrl, setVideoUrl]       = useState(null)
  const [activeFlag, setActiveFlag]   = useState(null)
  const [isLooping, setIsLooping]     = useState(false)
  const [scoreReady, setScoreReady]   = useState(false)
  const [highlights, setHighlights]   = useState([])  // [{flagId, x, y, w, h}]

  // Chat state
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput]       = useState('')
  const [chatLoading, setChatLoading]   = useState(false)
  const chatEndRef = useRef(null)
  const takeId = searchParams.get('takeId')

  // Load take from Supabase when takeId is present; otherwise fall back to localStorage.
  useEffect(() => {
    let cancelled = false

    async function loadTake() {
      if (takeId) {
        const { data, error } = await supabase
          .from('takes')
          .select('id, piece_title, piece_composer, instrument, score, flags, video_path, video_mime_type, score_path, measure_layout, audio_alignment, analysis_quality, analysis_backend, created_at')
          .eq('id', takeId)
          .single()

        if (!cancelled) {
          if (error) {
            console.error('Could not load take from Supabase:', error)
            setTake(null)
          } else {
            setTake(data)
          }
        }
        return
      }

      try {
        const stored = localStorage.getItem('mediant_last_take')
        if (!cancelled) setTake(stored ? JSON.parse(stored) : null)
      } catch {
        if (!cancelled) setTake(null)
      }
    }

    loadTake()
    return () => { cancelled = true }
  }, [takeId])

  // Generate signed URL for uploaded score (if stored in Supabase)
  useEffect(() => {
    if (!take?.score_path) return
    supabase.storage
      .from('sheet-music')
      .createSignedUrl(take.score_path, 3600)
      .then(({ data }) => { if (data?.signedUrl) setScoreUrl(data.signedUrl) })
  }, [take])

  // Generate signed URL for the video recording
  useEffect(() => {
    if (!take?.video_path) return
    supabase.storage
      .from('recordings')
      .createSignedUrl(take.video_path, 3600)
      .then(({ data }) => { if (data?.signedUrl) setVideoUrl(data.signedUrl) })
  }, [take])

  // Loop the active excerpt whenever isLooping changes
  useEffect(() => {
    const video = videoRef.current
    if (!video || !isLooping || !loopRef.current) return
    const { start, end } = loopRef.current

    function seekAndPlay() {
      try { video.currentTime = start } catch { /* ignore */ }
      video.play().catch(() => {})
    }

    if (video.readyState >= 1) {
      seekAndPlay()
    } else {
      video.addEventListener('loadedmetadata', seekAndPlay, { once: true })
    }

    function onTimeUpdate() {
      if (videoRef.current && videoRef.current.currentTime >= end) {
        try { videoRef.current.currentTime = start } catch { /* ignore */ }
      }
    }
    video.addEventListener('timeupdate', onTimeUpdate)
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('loadedmetadata', seekAndPlay)
      video.pause()
    }
  }, [isLooping])

  const startLoop = useCallback((flag) => {
    if (flag?.timestamp_start == null || flag?.timestamp_end == null) return
    const start = Number(flag.timestamp_start)
    const end   = Number(flag.timestamp_end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return
    loopRef.current = { start, end }
    setIsLooping(true)
  }, [])

  const stopLoop = useCallback(() => {
    setIsLooping(false)
    loopRef.current = null
  }, [])

  // Stop loop when active flag changes
  useEffect(() => { stopLoop() }, [activeFlag, stopLoop])

  // Determine if score is a visual file (photo/PDF) vs MusicXML
  const isVisualScore = scoreUrl && (() => {
    const p = (take?.score_path ?? '').toLowerCase()
    return /\.(jpe?g|png|webp|heic|pdf)$/.test(p)
  })()

  // Render score once take is resolved (only for MusicXML files)
  useEffect(() => {
    if (take === undefined) return
    if (!scoreEl.current) return
    if (scoreReady) return
    if (isVisualScore) { setScoreReady(true); return }

    const pieceTitle = take?.piece_title ?? ''
    const scoreFile  = scoreUrl ?? scoreFileForPiece(pieceTitle)

    if (!scoreFile) {
      setScoreReady(true)
      return
    }

    const flagMeasures = take?.flags?.length
      ? new Map(take.flags.map((f, i) => [f.measure, `flag_${i}`]))
      : new Map()

    const osmd = new OpenSheetMusicDisplay(scoreEl.current, {
      autoResize: true,
      backend: 'svg',
      drawTitle: false,
      drawComposer: false,
      drawCredits: false,
      drawPartNames: false,
      drawMeasureNumbers: true,
      measureNumberInterval: 1,
    })
    osmdRef.current = osmd

    osmd.load(scoreFile)
      .then(() => {
        osmd.render()
        setScoreReady(true)

        // Build highlight rects from measure positions
        try {
          const measureList = osmd.GraphicSheet.MeasureList
          const zoom = osmd.zoom * 10
          const newHighlights = []

          flagMeasures.forEach((flagId, measureNum) => {
            const row = measureList[measureNum - 1]
            if (!row) return
            const gm = row[0]
            if (!gm) return
            const pos = gm.PositionAndShape
            newHighlights.push({
              flagId,
              x: pos.AbsolutePosition.x * zoom,
              y: pos.AbsolutePosition.y * zoom,
              w: pos.Size.width * zoom,
              h: pos.Size.height * zoom,
            })
          })
          setHighlights(newHighlights)
        } catch (e) {
          console.warn('Could not compute measure highlights:', e)
        }
      })
      .catch(err => {
        console.error('OSMD load error:', err)
        setScoreReady(true)
      })
  }, [take, scoreUrl])

  // Scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, chatLoading])

  async function sendMessage() {
    const msg = chatInput.trim()
    if (!msg || chatLoading) return
    setChatInput('')

    // Snapshot whichever issue is active at send time so the history stays accurate
    const flagContext = activeFlagRaw
      ? { measure: activeFlagRaw.measure, type: activeFlagRaw.type, title: activeFlagRaw.title }
      : null

    setChatMessages(prev => [...prev, { role: 'user', content: msg, flagContext }])
    setChatLoading(true)

    try {
      const res = await fetch('/api/ask-coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          context: {
            pieceTitle:      take?.piece_title    ?? '',
            pieceComposer:   take?.piece_composer ?? '',
            score:           take?.score,
            flags:           take?.flags ?? [],
            activeFlag:      flagContext ?? null,
            measureLayout:   take?.measure_layout ?? null,
            audioAlignment:  take?.audio_alignment ?? null,
          },
          history: chatMessages,
        }),
      })
      const { reply, error } = await res.json()
      if (error) throw new Error(error)
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Try again.' }])
    } finally {
      setChatLoading(false)
    }
  }

  const flagsMap = take?.flags?.length
    ? Object.fromEntries(
        take.flags.map((f, i) => [
          `flag_${i}`,
          { tag: `Measure ${f.measure} · ${capitalize(f.type)}`, title: f.title, body: f.body },
        ])
      )
    : {}

  const chips = take?.flags?.length
    ? take.flags.map((f, i) => ({ flag: `flag_${i}`, label: `m.${f.measure} · ${capitalize(f.type)}` }))
    : []

  const pieceTitle    = take?.piece_title    ?? ''
  const pieceComposer = take?.piece_composer ?? ''
  const instrument    = take?.instrument     ?? null
  const issueCount    = chips.length
  const score         = take?.score
  const hasScore      = !!scoreUrl || !!scoreFileForPiece(pieceTitle)
  const analysisQuality = take?.analysis_quality ?? null
  const analysisBackend = take?.analysis_backend ?? null

  // Raw flag data for the active flag (has timestamps, bbox, etc.)
  const activeFlagIndex = activeFlag ? parseInt(activeFlag.replace('flag_', ''), 10) : -1
  const activeFlagRaw   = take?.flags?.[activeFlagIndex] ?? null
  const hasTimestamps   = activeFlagRaw?.timestamp_start != null && activeFlagRaw?.timestamp_end != null

  const info = activeFlag ? flagsMap[activeFlag] : null

  if (take === undefined) {
    return (
      <div className={styles.page}>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>♩</div>
          <p className={styles.analyzeSub}>Loading your analysis…</p>
        </div>
      </div>
    )
  }

  if (take === null) {
    return (
      <div className={styles.page}>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>♩</div>
          <p className={styles.analyzeTitle}>No recording yet</p>
          <p className={styles.analyzeSub}>Upload a recording to see your score review here.</p>
          <button className={styles.primaryBtn} style={{ marginTop: 16 }} onClick={() => nav('/record')}>
            Upload a recording →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Score Review</p>
          <h1 className={styles.reviewTitle}>{pieceTitle}</h1>
          <p className={styles.sub}>
            {pieceComposer}{instrument ? ` · ${instrument}` : ''} · {issueCount} issue{issueCount !== 1 ? 's' : ''} found
            {score != null && <> · <span style={{ color: scoreColor(score) }}>{score}/100</span></>}
            {timeAgo(take?.created_at ?? take?.date) && (
              <> · <span style={{ color: 'rgba(248,246,242,0.35)' }}>Analyzed {timeAgo(take?.created_at ?? take?.date)}</span></>
            )}
          </p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.ghostBtn} onClick={() => nav('/record')}>Re-upload</button>
        </div>
      </div>

      {analysisQuality && (
        <div className={`${styles.analysisNotice} ${styles[`analysisNotice${trustTone(analysisQuality.trust)}`]}`}>
          <p className={styles.analysisNoticeTitle}>{trustLabel(analysisQuality.trust)}</p>
          <p className={styles.analysisNoticeBody}>
            {analysisBackend ? `Pipeline: ${analysisBackend}. ` : ''}
            {analysisQuality.trust === 'high'
              ? 'This review is grounded in aligned score and recording evidence with direct listening corroboration.'
              : 'This review was generated from usable evidence, but some parts of the analysis chain were weaker than ideal.'}
          </p>
          {Array.isArray(analysisQuality.reasons) && analysisQuality.reasons.length > 0 && (
            <ul className={styles.analysisNoticeList}>
              {analysisQuality.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className={styles.issueStrip}>
        <span className={styles.issueStripLabel}>Issues:</span>
        {chips.length === 0
          ? <span className={styles.issueStripHint}>No issues detected — performance looks clean.</span>
          : <>
              {chips.map(({ flag, label }) => (
                <button
                  key={flag}
                  className={`${styles.issueChip} ${activeFlag === flag ? styles.issueChipActive : ''}`}
                  onClick={() => setActiveFlag(activeFlag === flag ? null : flag)}
                >
                  {label}
                </button>
              ))}
              <span className={styles.issueStripHint}>Click a highlighted measure or issue to read feedback.</span>
            </>
        }
      </div>

      <div className={styles.reviewBody}>
        <div className={styles.scoreArea}>
          {/* Photo or PDF uploaded by user — with bbox overlays */}
          {isVisualScore && scoreUrl && (
            (take?.score_path ?? '').toLowerCase().endsWith('.pdf') ? (
              <iframe
                src={scoreUrl}
                className={styles.scorePdf}
                title="Sheet music"
              />
            ) : (
              <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
                <img
                  src={scoreUrl}
                  className={styles.scorePhoto}
                  alt="Sheet music"
                />
                {(take?.flags ?? []).map((f, i) => {
                  if (!f.spot) return null
                  const flagId = `flag_${i}`
                  const active = activeFlag === flagId
                  if (!active) return null
                  const [y0, x0, y1, x1] = f.spot
                  const angle = f.spot_angle ?? 0
                  // Center the div at the midpoint, then rotate around that center
                  const cx = (x0 + x1) / 2 / 10
                  const cy = (y0 + y1) / 2 / 10
                  const w  = (x1 - x0) / 10
                  const h  = (y1 - y0) / 10
                  return (
                    <div
                      key={flagId}
                      onClick={() => setActiveFlag(a => a === flagId ? null : flagId)}
                      style={{
                        position:        'absolute',
                        left:            `${cx}%`,
                        top:             `${cy}%`,
                        width:           `${w}%`,
                        height:          `${h}%`,
                        transform:       `translate(-50%, -50%) rotate(${angle}deg)`,
                        transformOrigin: 'center center',
                        background:      active ? 'rgba(210,60,60,0.38)' : 'rgba(210,60,60,0.18)',
                        borderRadius:    3,
                        cursor:          'pointer',
                        transition:      'background 150ms ease',
                        pointerEvents:   'auto',
                      }}
                    />
                  )
                })}
              </div>
            )
          )}

          {/* OSMD render target + highlight overlays (MusicXML only) */}
          {!isVisualScore && (
            <>
              {!hasScore && scoreReady && (
                <div className={styles.scoreUnavailable}>
                  <p>Score not available for <em>{pieceTitle}</em> yet.</p>
                  <p>Coaching feedback above is based on the audio analysis.</p>
                </div>
              )}
              <div style={{ position: 'relative' }}>
                <div ref={scoreEl} />
                {scoreReady && highlights.map(({ flagId, x, y, w, h }) => (
                  <div
                    key={flagId}
                    onClick={() => setActiveFlag(f => f === flagId ? null : flagId)}
                    style={{
                      position:     'absolute',
                      left:         x,
                      top:          y,
                      width:        w,
                      height:       h,
                      background:   activeFlag === flagId ? 'rgba(225,134,118,0.18)' : 'rgba(225,134,118,0.09)',
                      border:       '1.5px solid rgba(225,134,118,0.5)',
                      borderRadius: 6,
                      cursor:       'pointer',
                      transition:   'background 150ms ease',
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <aside className={styles.feedbackSidebar}>
          <div className={styles.feedbackPanel}>
            {!info ? (
              <div className={styles.feedbackIdle}>
                <span className={styles.feedbackIdleIcon}>♩</span>
                <p>Click a highlighted measure in the score, or one of the issue chips above, to read coaching feedback.</p>
              </div>
            ) : (
              <div className={styles.feedbackDetail}>
                <p className={styles.detailTag}>{info.tag}</p>
                <h3 className={styles.detailTitle}>{info.title}</h3>
                <p className={styles.detailBody}>{info.body}</p>

                {/* Video excerpt player */}
                {videoUrl && hasTimestamps && (
                  <div className={styles.excerptPlayer}>
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      className={styles.excerptVideo}
                      playsInline
                      preload="metadata"
                    />
                    <div className={styles.excerptControls}>
                      {!isLooping ? (
                        <button className={styles.loopBtn} onClick={() => startLoop(activeFlagRaw)}>
                          ▶ Loop m.{activeFlagRaw.measure}
                        </button>
                      ) : (
                        <button className={styles.loopBtn} style={{ background: 'var(--coral)' }} onClick={stopLoop}>
                          ■ Stop loop
                        </button>
                      )}
                      <span className={styles.excerptTime}>
                        {activeFlagRaw.timestamp_start.toFixed(1)}s – {activeFlagRaw.timestamp_end.toFixed(1)}s
                      </span>
                    </div>
                  </div>
                )}

                <button className={styles.dismissBtn} onClick={() => setActiveFlag(null)}>Dismiss</button>
              </div>
            )}
          </div>

          <div className={styles.chatSection}>
            <div className={styles.chatHeader}>
              <p className={styles.chatLabel}>Ask your coach</p>
              {activeFlagRaw && (
                <span className={styles.chatContextPill}>
                  Re: m.{activeFlagRaw.measure} · {capitalize(activeFlagRaw.type)}
                </span>
              )}
            </div>
            <div className={styles.chatMessages}>
              {chatMessages.length === 0 && (
                <p className={styles.chatEmpty}>
                  {activeFlagRaw
                    ? `Ask about m.${activeFlagRaw.measure} · ${capitalize(activeFlagRaw.type)}, or anything else about your performance.`
                    : 'Select an issue above, then ask your coach about it — or ask anything about your performance.'}
                </p>
              )}
              {chatMessages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? styles.chatMsgUser : styles.chatMsgAI}>
                  {m.role === 'user' && m.flagContext && (
                    <span className={styles.chatMsgContext}>
                      Re: m.{m.flagContext.measure} · {capitalize(m.flagContext.type)}
                    </span>
                  )}
                  {m.content}
                </div>
              ))}
              {chatLoading && (
                <div className={styles.chatMsgAI}>
                  <span className={styles.chatTyping}>···</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className={styles.chatInputRow}>
              <input
                className={styles.chatInput}
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendMessage()}
                placeholder="Ask about your performance…"
                disabled={chatLoading}
              />
              <button
                className={styles.chatSend}
                onClick={sendMessage}
                disabled={chatLoading || !chatInput.trim()}
              >↑</button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

function scoreColor(n) {
  if (n >= 88) return '#8fbe9f'
  if (n >= 74) return 'var(--gold)'
  return 'var(--coral)'
}
