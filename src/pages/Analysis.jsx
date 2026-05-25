import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { supabase } from '../lib/supabase'
import MasterclassPanel from '../components/MasterclassPanel'
import styles from './Page.module.css'
import aStyles from './Analysis.module.css'
import { playTick } from '../utils/sounds'

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

const TYPE_META = {
  technique:    { icon: '⊙', cls: 'iconGreen' },
  intonation:   { icon: '♯', cls: 'iconCoral' },
  rhythm:       { icon: '♩', cls: 'iconGold'  },
  timing:       { icon: '♩', cls: 'iconGold'  },
  dynamics:     { icon: 'ƒ', cls: 'iconCoral' },
  articulation: { icon: '▸', cls: 'iconGold'  },
  tone:         { icon: '◎', cls: 'iconGreen' },
  phrasing:     { icon: '∿', cls: 'iconGold'  },
  expression:   { icon: '∿', cls: 'iconGold'  },
  posture:      { icon: '⊕', cls: 'iconGreen' },
}
function flagTypeMeta(type) {
  return TYPE_META[(type ?? '').toLowerCase()] ?? { icon: '◆', cls: 'iconCoral' }
}

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
  const loopRef     = useRef(null)

  // Sticky score boundary refs
  const scoreColRef     = useRef(null)   // the outer sticky column
  const scoreInnerRef   = useRef(null)   // inner wrapper that gets translateY'd
  const sentinelRef     = useRef(null)   // placed right after confidence notices
  const summaryRef      = useRef(null)   // placed on the summary section
  const reviewLayoutRef = useRef(null)   // the two-column grid

  const [take, setTake]               = useState(undefined)
  const [scoreUrl, setScoreUrl]       = useState(null)
  const [videoUrl, setVideoUrl]       = useState(null)
  const [activeFlag, setActiveFlag]   = useState(null)
  const [isLooping, setIsLooping]     = useState(false)
  const [scoreReady, setScoreReady]   = useState(false)
  const [highlights, setHighlights]   = useState([])
  const [videoSpeed, setVideoSpeed]   = useState(1)

  // AI summary state
  const [summary, setSummary]             = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError]   = useState(null)

  // Keyboard shortcut state ref — always current without re-registering the listener
  const kbRef = useRef({})

  // Chat state
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput]       = useState('')
  const [chatLoading, setChatLoading]   = useState(false)
  const chatEndRef = useRef(null)
  const takeId = searchParams.get('takeId')

  // Load take from Supabase when takeId is present; otherwise fall back to localStorage.
  // If the take is still processing, poll every 4s until it finishes.
  useEffect(() => {
    let cancelled = false
    let pollTimer = null

    async function loadTake() {
      if (takeId) {
        const { data, error } = await supabase
          .from('takes')
          .select('id, piece_title, piece_composer, instrument, score, flags, video_path, video_mime_type, score_path, measure_layout, audio_alignment, analysis_quality, analysis_backend, job_status, job_error, created_at')
          .eq('id', takeId)
          .single()

        if (!cancelled) {
          if (error) {
            console.error('Could not load take from Supabase:', error)
            setTake(null)
          } else if (data?.job_status === 'processing') {
            // Job still running — show a waiting screen and poll again in 4s
            setTake({ ...data, _polling: true })
            pollTimer = setTimeout(loadTake, 4000)
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
    return () => { cancelled = true; clearTimeout(pollTimer) }
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

  // Derive activeFlagRaw here so hooks below can reference it without TDZ
  const activeFlagIndex = activeFlag ? parseInt(activeFlag.replace('flag_', ''), 10) : -1
  const activeFlagRaw   = take?.flags?.[activeFlagIndex] ?? null
  const hasTimestamps   = activeFlagRaw?.timestamp_start != null && activeFlagRaw?.timestamp_end != null
    && Number(activeFlagRaw.timestamp_end) > Number(activeFlagRaw.timestamp_start)

  const flagsMap = take?.flags?.length
    ? Object.fromEntries(
        take.flags.map((f, i) => [
          `flag_${i}`,
          { tag: `Measure ${f.measure} · ${capitalize(f.type)}`, title: f.title, body: f.detail ?? f.body ?? '', confidence: f.confidence ?? 100 },
        ])
      )
    : {}

  const chips = take?.flags?.length
    ? take.flags.map((f, i) => ({
        flag:       `flag_${i}`,
        label:      `m.${f.measure} · ${capitalize(f.type)}`,
        confidence: f.confidence ?? 100,
      }))
    : []

  // Auto-seek video to flag's timestamp when a flag is selected
  useEffect(() => {
    if (!activeFlagRaw) return
    const start = Number(activeFlagRaw.timestamp_start)
    const end   = Number(activeFlagRaw.timestamp_end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return

    function seek() {
      const video = videoRef.current
      if (video) video.currentTime = start
    }

    // Video may not be in DOM yet — wait one frame for React to commit
    const raf = requestAnimationFrame(() => {
      const video = videoRef.current
      if (!video) return
      if (video.readyState >= 1) {
        seek()
      } else {
        video.addEventListener('loadedmetadata', seek, { once: true })
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [activeFlagRaw])

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
    // If the take has a score_path, wait for the signed URL before deciding
    if (take?.score_path && !scoreUrl) return
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

  // Apply playback rate whenever videoSpeed changes
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = videoSpeed
  }, [videoSpeed])

  // Scroll-driven sticky score: top boundary = below confidence notice,
  // bottom boundary = before summary section, auto-pan when score is taller than viewport.
  useEffect(() => {
    const col   = scoreColRef.current
    const inner = scoreInnerRef.current
    if (!col || !inner) return

    const TOP_GAP    = 12
    const BOTTOM_GAP = 16

    function update() {
      const sentinel = sentinelRef.current
      const summary  = summaryRef.current
      const layout   = reviewLayoutRef.current
      if (!sentinel || !summary || !layout) return

      // Top boundary: just below the sentinel (= bottom of confidence notices block)
      const sentinelBottom = sentinel.getBoundingClientRect().bottom
      const topBound = Math.max(TOP_GAP, sentinelBottom + TOP_GAP)

      // Bottom boundary: just above the summary section
      const summaryTop  = summary.getBoundingClientRect().top
      const visibleH    = Math.max(80, summaryTop - topBound - BOTTOM_GAP)

      col.style.top       = `${topBound}px`
      col.style.maxHeight = `${visibleH}px`

      // Auto-pan the inner content when taller than the visible window
      const contentH = inner.scrollHeight
      const overflow = Math.max(0, contentH - visibleH)

      if (overflow > 0) {
        // Progress: how far have we scrolled through the review layout?
        const layoutTop    = layout.getBoundingClientRect().top
        const scrolled     = Math.max(0, -layoutTop + topBound)
        const maxScroll    = Math.max(1, layout.offsetHeight - visibleH)
        const progress     = Math.min(1, scrolled / maxScroll)
        inner.style.transform = `translateY(-${overflow * progress}px)`
      } else {
        inner.style.transform = 'translateY(0)'
      }
    }

    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update, { passive: true })
    update()
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [scoreReady]) // re-run after score renders so contentH is accurate

  // Keep keyboard shortcut ref current on every render
  kbRef.current = { activeFlagIndex, activeFlagRaw, chips, hasTimestamps, isLooping }

  // Global keyboard shortcuts — registered once, reads latest state via ref
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const s = kbRef.current
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        const v = videoRef.current
        if (v) { if (v.paused) v.play().catch(() => {}); else v.pause() }
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (s.activeFlagIndex > 0) setActiveFlag(`flag_${s.activeFlagIndex - 1}`)
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const next = s.activeFlagIndex >= 0 ? s.activeFlagIndex + 1 : 0
        if (next < s.chips.length) setActiveFlag(`flag_${next}`)
      }
      if (e.key === 'l' || e.key === 'L') {
        if (s.isLooping) stopLoop()
        else if (s.activeFlagRaw && s.hasTimestamps) startLoop(s.activeFlagRaw)
      }
      if (e.key === 'Escape') setActiveFlag(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [startLoop, stopLoop])

  async function generateSummary() {
    if (!take?.flags?.length) return
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('analysis-summary', {
        body: {
          pieceTitle:    take.piece_title    ?? '',
          pieceComposer: take.piece_composer ?? '',
          instrument:    take.instrument     ?? null,
          score:         take.score          ?? null,
          flags:         take.flags,
        },
      })
      if (fnErr) throw new Error(fnErr.message ?? String(fnErr))
      if (data?.error) throw new Error(data.error)
      setSummary(data.summary)
    } catch {
      setSummaryError('Could not generate summary. Try again.')
    } finally {
      setSummaryLoading(false)
    }
  }

  // Auto-generate summary once when the take finishes loading
  useEffect(() => {
    if (take && take.flags?.length && !take._polling) {
      generateSummary()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take?.id])

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
      const { data, error } = await supabase.functions.invoke('coach-chat', {
        body: {
          message: msg,
          context: {
            pieceTitle:    take?.piece_title    ?? '',
            pieceComposer: take?.piece_composer ?? '',
            instrument:    take?.instrument     ?? null,
            flags:         take?.flags          ?? [],
            activeFlag:    flagContext          ?? null,
          },
          history: chatMessages,
        },
      })
      if (error) throw new Error(error.message ?? String(error))
      setChatMessages(prev => [...prev, { role: 'assistant', content: data?.reply ?? '' }])
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Try again.' }])
    } finally {
      setChatLoading(false)
    }
  }

  const pieceTitle    = take?.piece_title    ?? ''
  const pieceComposer = take?.piece_composer ?? ''
  const instrument    = take?.instrument     ?? null
  const issueCount    = chips.length
  const score         = take?.score
  const hasScore      = !!scoreUrl || !!scoreFileForPiece(pieceTitle)
  const analysisQuality = take?.analysis_quality ?? null

  const info = activeFlag ? flagsMap[activeFlag] : null

  // Chips sorted by measure for the new issue grid
  const sortedChips = useMemo(() => {
    return [...chips].sort((a, b) => {
      const ia = parseInt(a.flag.replace('flag_', ''), 10)
      const ib = parseInt(b.flag.replace('flag_', ''), 10)
      const ma = take?.flags?.[ia]?.measure ?? 0
      const mb = take?.flags?.[ib]?.measure ?? 0
      return ma - mb
    })
  }, [chips, take?.flags])


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

  if (take?._polling) {
    return (
      <div className={styles.page}>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>♪</div>
          <h2 className={styles.analyzeTitle}>Analysis in progress…</h2>
          <p className={styles.analyzeSub}>Mediant is analyzing your performance — this takes 1–3 minutes. This page will update automatically.</p>
          {take.job_error && (
            <p style={{ color: 'var(--coral)', marginTop: 12, fontSize: 14 }}>{take.job_error}</p>
          )}
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

  // ── Score area JSX (shared between columns) ──────────────────
  const scoreAreaContent = (
    <div className={styles.scoreArea}>
      {isVisualScore && scoreUrl && (
        (take?.score_path ?? '').toLowerCase().endsWith('.pdf') ? (
          <iframe src={scoreUrl} className={styles.scorePdf} title="Sheet music" />
        ) : (
          <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}>
            <img src={scoreUrl} className={styles.scorePhoto} alt="Sheet music" />
            {(take?.flags ?? []).map((f, i) => {
              if (!f.spot) return null
              const flagId = `flag_${i}`
              if (activeFlag !== flagId) return null
              const [y0, x0, y1, x1] = f.spot
              const angle = f.spot_angle ?? 0
              const cx = (x0 + x1) / 2 / 10, cy = (y0 + y1) / 2 / 10
              const w = (x1 - x0) / 10, h = (y1 - y0) / 10
              return (
                <div key={flagId} onClick={() => setActiveFlag(a => a === flagId ? null : flagId)}
                  style={{
                    position: 'absolute', left: `${cx}%`, top: `${cy}%`,
                    width: `${w}%`, height: `${h}%`,
                    transform: `translate(-50%, -50%) rotate(${angle}deg)`,
                    transformOrigin: 'center center',
                    background: 'rgba(88,121,101,0.3)', borderRadius: 3,
                    cursor: 'pointer', transition: 'background 150ms ease',
                  }}
                />
              )
            })}
          </div>
        )
      )}
      {!isVisualScore && (
        <>
          {!hasScore && scoreReady && (
            <div className={styles.scoreUnavailable}>
              <p>Score not available for <em>{pieceTitle}</em> yet.</p>
              <p>Feedback is based on the performance analysis.</p>
            </div>
          )}
          <div style={{ position: 'relative' }}>
            <div ref={scoreEl} />
            {scoreReady && highlights.map(({ flagId, x, y, w, h }) => (
              <div key={flagId} onClick={() => setActiveFlag(f => f === flagId ? null : flagId)}
                style={{
                  position: 'absolute', left: x, top: y, width: w, height: h,
                  background: activeFlag === flagId ? 'rgba(88,121,101,0.22)' : 'rgba(88,121,101,0.08)',
                  border: `1.5px solid rgba(88,121,101,${activeFlag === flagId ? '0.55' : '0.28'})`,
                  borderRadius: 6, cursor: 'pointer', transition: 'background 150ms ease',
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )

  return (
    <div className={styles.page}>

      {/* ── Header ── */}
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Score Review</p>
          <h1 className={styles.reviewTitle}>{pieceTitle}</h1>
          <p className={styles.sub}>
            {[pieceComposer, instrument].filter(Boolean).join(' · ')}
            {score != null && (
              <> · <span style={{ color: scoreColor(score), fontWeight: 600 }}>{score}/100</span></>
            )}
            {analysisQuality?.trust && (
              <> · <span style={{
                color: analysisQuality.trust === 'high' ? 'var(--hero-green)' : analysisQuality.trust === 'medium' ? 'var(--gold)' : 'var(--coral)',
                fontWeight: 500,
              }}>
                {analysisQuality.trust === 'high' ? '● High confidence' : analysisQuality.trust === 'medium' ? '◑ Medium confidence' : '○ Low confidence'}
              </span></>
            )}
            {timeAgo(take?.created_at ?? take?.date) && (
              <> · <span style={{ color: 'rgba(248,246,242,0.32)' }}>Analyzed {timeAgo(take?.created_at ?? take?.date)}</span></>
            )}
          </p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.ghostBtn} onClick={() => nav('/record')}>Re-upload</button>
        </div>
      </div>

      {/* ── Confidence notices ── */}
      {analysisQuality?.trust === 'low' && Array.isArray(analysisQuality.reasons) && analysisQuality.reasons.length > 0 && (
        <div className={`${styles.analysisNotice} ${styles.analysisNoticeLow}`}>
          <p className={styles.analysisNoticeTitle}>Analysis confidence was too low for precise feedback</p>
          <ul className={styles.analysisNoticeList}>
            {analysisQuality.reasons.map(r => <li key={r}>{r}</li>)}
          </ul>
          <p style={{ marginTop: 8, fontSize: 13, opacity: 0.75 }}>Try uploading a MusicXML file for higher accuracy, or record a cleaner excerpt with less background noise.</p>
        </div>
      )}
      {analysisQuality?.trust === 'medium' && Array.isArray(analysisQuality.reasons) && analysisQuality.reasons.length > 0 && (
        <div className={`${styles.analysisNotice} ${styles.analysisNoticeMedium}`}>
          <p className={styles.analysisNoticeTitle}>Medium confidence — feedback may be slightly imprecise</p>
          <ul className={styles.analysisNoticeList}>
            {analysisQuality.reasons.map(r => <li key={r}>{r}</li>)}
          </ul>
          <p style={{ marginTop: 8, fontSize: 13, opacity: 0.75 }}>For higher accuracy, upload a MusicXML or MXL file instead of a photo or PDF.</p>
        </div>
      )}

      {/* Sentinel: placed right here so JS knows where the confidence block ends */}
      <div ref={sentinelRef} style={{ height: 0, margin: 0, padding: 0 }} />

      {/* ── Two-column: score left (sticky) + issues right ── */}
      <div className={aStyles.reviewLayout} ref={reviewLayoutRef}>

        {/* Left: sheet music — sticky, JS drives top/maxHeight/pan */}
        <div className={aStyles.scoreColumn} ref={scoreColRef}>
          <div className={aStyles.scoreInner} ref={scoreInnerRef}>
            {scoreAreaContent}
          </div>
        </div>

        {/* Right: issues, detail panel, video */}
        <div className={aStyles.rightColumn}>

          {/* Issue grid */}
          <section className={aStyles.issueSection}>
            <div className={aStyles.issueSectionHeader}>
              <p className={styles.label}>
                {issueCount > 0 ? `${issueCount} Issue${issueCount !== 1 ? 's' : ''} Found` : 'Issues'}
              </p>
              {issueCount > 0 && (
                <span className={aStyles.issueSortHint}>Sorted by measure · click to review</span>
              )}
            </div>

            {issueCount === 0 ? (
              <div className={aStyles.issueClean}>✓ Clean performance — no issues detected.</div>
            ) : (
              <div className={aStyles.issueGrid}>
                {sortedChips.map(({ flag, confidence }) => {
                  const idx  = parseInt(flag.replace('flag_', ''), 10)
                  const f    = take.flags[idx]
                  const meta = flagTypeMeta(f?.type)
                  const confColor = confidence >= 90 ? 'var(--hero-green)' : confidence >= 75 ? 'var(--gold)' : 'rgba(248,246,242,0.2)'
                  return (
                    <button
                      key={flag}
                      className={`${aStyles.issueCard} ${activeFlag === flag ? aStyles.issueCardActive : ''}`}
                      onClick={() => { playTick(); setActiveFlag(activeFlag === flag ? null : flag) }}
                    >
                      <div className={aStyles.issueCardTop}>
                        <span className={`${aStyles.issueTypeIcon} ${aStyles[meta.cls]}`}>{meta.icon}</span>
                        <span className={aStyles.issueMeasureNum}>m.{f?.measure}</span>
                        <span className={aStyles.issueConfDot} style={{ background: confColor }} />
                      </div>
                      <span className={aStyles.issueCardType}>{capitalize(f?.type)}</span>
                      <span className={aStyles.issueCardTitle}>{f?.title}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Detail panel — expands below grid when a card is selected */}
            {info && (
              <div className={aStyles.issueDetailPanel}>
                <div className={aStyles.issueDetailTop}>
                  <span className={`${aStyles.issueDetailBadge} ${aStyles[flagTypeMeta(activeFlagRaw?.type).cls]}`}>
                    {flagTypeMeta(activeFlagRaw?.type).icon}
                  </span>
                  <span className={aStyles.issueDetailMeasure}>m.{activeFlagRaw?.measure}</span>
                  <span className={aStyles.issueDetailType}>{capitalize(activeFlagRaw?.type)}</span>
                  {info.confidence != null && (
                    <span className={aStyles.issueDetailConf} style={{
                      color: info.confidence >= 90 ? 'var(--hero-green)' : info.confidence >= 75 ? 'var(--gold)' : 'rgba(248,246,242,0.4)',
                    }}>
                      {info.confidence >= 90 ? '● high' : info.confidence >= 75 ? '◑ medium' : '○ lower'} confidence
                    </span>
                  )}
                  <button className={aStyles.issueDetailDismiss} onClick={() => setActiveFlag(null)}>✕</button>
                </div>
                <div className={aStyles.issueDetailBody}>
                  <h3 className={aStyles.issueDetailTitle}>{info.title}</h3>
                  <p className={aStyles.issueDetailText}>{info.body}</p>
                  {videoUrl && hasTimestamps && (
                    <div className={aStyles.issueDetailActions}>
                      {!isLooping ? (
                        <button className={aStyles.loopBtn} onClick={() => startLoop(activeFlagRaw)}>
                          ▶ Loop m.{activeFlagRaw.measure}
                        </button>
                      ) : (
                        <button className={aStyles.loopStopBtn} onClick={stopLoop}>■ Stop loop</button>
                      )}
                      <span className={aStyles.excerptTime}>
                        {Number(activeFlagRaw.timestamp_start).toFixed(1)}s – {Number(activeFlagRaw.timestamp_end).toFixed(1)}s
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Video player */}
          {videoUrl && (
            <div className={styles.videoBar}>
              <span className={styles.videoBarLabel}>Recording</span>
              <video
                ref={videoRef}
                src={videoUrl}
                className={styles.videoBarPlayer}
                controls
                playsInline
                preload="metadata"
              />
              <div className={styles.videoControls}>
                <span className={styles.videoControlsLabel}>Speed</span>
                <div className={styles.speedBtns}>
                  {[0.5, 0.75, 1, 1.25, 1.5].map(s => (
                    <button
                      key={s}
                      className={`${styles.speedBtn} ${videoSpeed === s ? styles.speedBtnActive : ''}`}
                      onClick={() => setVideoSpeed(s)}
                    >{s}×</button>
                  ))}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ── AI-generated summary (full-width, below two-column) ── */}
      <section className={aStyles.summarySection} ref={summaryRef}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <p className={styles.label}>Session Summary</p>
          {summary && !summaryLoading && (
            <button className={aStyles.summaryRetryBtn} onClick={generateSummary}>Regenerate</button>
          )}
        </div>

        {summaryLoading && (
          <div className={aStyles.summaryLoading}>
            <span className={aStyles.summaryLoadingDot} />
            <span className={aStyles.summaryLoadingDot} />
            <span className={aStyles.summaryLoadingDot} />
            <span style={{ marginLeft: 6 }}>Generating your session summary…</span>
          </div>
        )}

        {summaryError && !summaryLoading && (
          <p className={aStyles.summaryError}>
            {summaryError}
            <button className={aStyles.summaryRetryBtn} onClick={generateSummary}>Retry</button>
          </p>
        )}

        {summary && !summaryLoading && (
          <>
            {summary.headline && (
              <h2 className={aStyles.summaryHeadline}>{summary.headline}</h2>
            )}
            {summary.overview && (
              <p className={aStyles.summaryOverview}>{summary.overview}</p>
            )}
            <div className={aStyles.summaryColumns}>
              {summary.strengths?.length > 0 && (
                <div className={`${aStyles.summaryCard} ${aStyles.summaryCardStrengths}`}>
                  <p className={`${aStyles.summaryCardTitle} ${aStyles.summaryCardTitleStrengths}`}>
                    ✓ Strengths
                  </p>
                  <ul className={aStyles.summaryList}>
                    {summary.strengths.map((s, i) => (
                      <li key={i} className={aStyles.summaryListItem}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {summary.improvements?.length > 0 && (
                <div className={`${aStyles.summaryCard} ${aStyles.summaryCardImprovements}`}>
                  <p className={`${aStyles.summaryCardTitle} ${aStyles.summaryCardTitleImprovements}`}>
                    → Areas to work on
                  </p>
                  <ul className={aStyles.summaryList}>
                    {summary.improvements.map((item, i) => (
                      <li key={i} className={aStyles.summaryListItem}>
                        {item.area && <span className={aStyles.summaryImprovementArea}>{item.area}</span>}
                        {item.guidance ?? item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}

        {!summary && !summaryLoading && !summaryError && issueCount === 0 && (
          <p className={aStyles.summaryOverview} style={{ color: 'var(--hero-green)' }}>
            No issues were flagged — great performance.
          </p>
        )}
      </section>

      {/* ── Ask Mediant chat ── */}
      <section className={aStyles.chatSection}>
        <div className={aStyles.chatSectionHeader}>
          <p className={styles.label}>Ask Mediant</p>
          {activeFlagRaw && (
            <span className={aStyles.chatContextPill}>
              Re: m.{activeFlagRaw.measure} · {capitalize(activeFlagRaw.type)}
            </span>
          )}
        </div>
        <div className={styles.chatMessages}>
          {chatMessages.length === 0 && (
            <p className={styles.chatEmpty}>
              {activeFlagRaw
                ? `Ask about m.${activeFlagRaw.measure} · ${capitalize(activeFlagRaw.type)}, or anything else about your performance.`
                : 'Select an issue above, then ask Mediant about it — or ask anything about your performance.'}
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
            <div className={styles.chatMsgAI}><span className={styles.chatTyping}>···</span></div>
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
      </section>

      <MasterclassPanel pieceTitle={pieceTitle} composer={pieceComposer} instrument={instrument} />
    </div>
  )
}

function scoreColor(n) {
  if (n >= 88) return '#8fbe9f'
  if (n >= 74) return 'var(--gold)'
  return 'var(--coral)'
}
