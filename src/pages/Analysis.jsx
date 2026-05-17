import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { supabase } from '../lib/supabase'
import styles from './Page.module.css'

// ── Hardcoded fallback (shown when no takeId in URL) ──────────────────────

const MOCK_FLAGS = {
  timing: {
    tag: 'Measure 16 · Timing',
    title: 'Left hand enters early',
    body: 'The left hand arrives just ahead of the beat here. Slow this entrance down and count aloud before bringing it back up to tempo. Try isolating the left hand through measures 14–17 until the arrival feels natural and unhurried.',
  },
  dynamics: {
    tag: 'Measure 28 · Dynamics',
    title: 'Phrase settles too early',
    body: 'The dynamic line softens before the phrase actually ends. Keep the line moving through the final note — the resolution should arrive at the cadence, not before it. Think of this as a long exhale, not a quick release.',
  },
  voicing: {
    tag: 'Measure 33 · Voicing',
    title: 'Inner voices too prominent',
    body: 'The middle voices are slightly louder than the melody, which blurs the harmonic texture. Bring the top line forward and let the inner voices recede — try exaggerated melody weight until the balance becomes instinctive.',
  },
}

const MOCK_CHIPS = [
  { flag: 'timing',   label: 'm.16 · Timing' },
  { flag: 'dynamics', label: 'm.28 · Dynamics' },
  { flag: 'voicing',  label: 'm.33 · Voicing' },
]

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

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

  const [take, setTake]               = useState(undefined)
  const [scoreUrl, setScoreUrl]       = useState(null)
  const [activeFlag, setActiveFlag]   = useState(null)
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
          .select('id, piece_title, piece_composer, score, flags, video_path, video_mime_type, score_path, created_at')
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

    const pieceTitle = take?.piece_title ?? 'Clair de Lune'
    const scoreFile  = scoreUrl ?? scoreFileForPiece(pieceTitle)

    if (!scoreFile) {
      setScoreReady(true)
      return
    }

    const flagMeasures = take?.flags?.length
      ? new Map(take.flags.map((f, i) => [f.measure, `flag_${i}`]))
      : new Map([[16, 'timing'], [28, 'dynamics'], [33, 'voicing']])

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
    setChatMessages(prev => [...prev, { role: 'user', content: msg }])
    setChatLoading(true)

    try {
      const res = await fetch('/api/ask-coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          context: {
            pieceTitle:    take?.piece_title    ?? 'Clair de Lune',
            pieceComposer: take?.piece_composer ?? 'Claude Debussy',
            score:         take?.score,
            flags:         take?.flags ?? [],
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

  // Derive FLAGS map and chips
  const flagsMap = take?.flags?.length
    ? Object.fromEntries(
        take.flags.map((f, i) => [
          `flag_${i}`,
          { tag: `Measure ${f.measure} · ${capitalize(f.type)}`, title: f.title, body: f.body },
        ])
      )
    : MOCK_FLAGS

  const chips = take?.flags?.length
    ? take.flags.map((f, i) => ({ flag: `flag_${i}`, label: `m.${f.measure} · ${capitalize(f.type)}` }))
    : MOCK_CHIPS

  const pieceTitle    = take?.piece_title    ?? 'Clair de Lune'
  const pieceComposer = take?.piece_composer ?? 'Claude Debussy'
  const issueCount    = chips.length
  const score         = take?.score
  const hasScore      = !!scoreUrl || !!scoreFileForPiece(pieceTitle)

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

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Score Review</p>
          <h1 className={styles.reviewTitle}>{pieceTitle}</h1>
          <p className={styles.sub}>
            {pieceComposer} · Solo Piano · {issueCount} issue{issueCount !== 1 ? 's' : ''} found
            {score != null && <> · <span style={{ color: scoreColor(score) }}>{score}/100</span></>}
          </p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.ghostBtn} onClick={() => nav('/record')}>Re-upload</button>
          <button className={styles.primaryBtn} onClick={() => nav('/follow')}>Follow Along ▶</button>
        </div>
      </div>

      <div className={styles.issueStrip}>
        <span className={styles.issueStripLabel}>Issues:</span>
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
      </div>

      <div className={styles.reviewBody}>
        <div className={styles.scoreArea}>
          {/* Photo or PDF uploaded by user */}
          {isVisualScore && scoreUrl && (
            (take?.score_path ?? '').toLowerCase().endsWith('.pdf') ? (
              <iframe
                src={scoreUrl}
                className={styles.scorePdf}
                title="Sheet music"
              />
            ) : (
              <img
                src={scoreUrl}
                className={styles.scorePhoto}
                alt="Sheet music"
              />
            )
          )}

          {/* OSMD render target + highlight overlays (MusicXML only) */}
          {!isVisualScore && (
            <>
              {!hasScore && scoreReady && (
                <div className={styles.scoreUnavailable}>
                  <p>Score not available for <em>{pieceTitle}</em> yet.</p>
                  <p>Coaching feedback above is based on the AI's audio analysis.</p>
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
                <button className={styles.loopBtn} onClick={() => nav('/follow')}>Loop this section</button>
                <button className={styles.dismissBtn} onClick={() => setActiveFlag(null)}>Dismiss</button>
              </div>
            )}
          </div>

          <div className={styles.chatSection}>
            <p className={styles.chatLabel}>Ask your coach</p>
            <div className={styles.chatMessages}>
              {chatMessages.length === 0 && (
                <p className={styles.chatEmpty}>Ask anything about your performance — technique, practice tips, or specific measures.</p>
              )}
              {chatMessages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? styles.chatMsgUser : styles.chatMsgAI}>
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
