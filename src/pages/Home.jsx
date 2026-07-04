import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTakes } from '../hooks/useTakes'
import { useRecordModal } from '../context/RecordModalContext'
import styles from './Home.module.css'
import { playPop } from '../utils/sounds'

function scoreColor(n) {
  if (n == null) return 'var(--text-faintest)'
  if (n >= 90) return 'var(--score-good)'
  if (n >= 74) return 'var(--score-ok)'
  return 'var(--score-bad)'
}

function calcStreak(sessions) {
  if (!sessions.length) return 0
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const dateSet = new Set(
    sessions.map(s => {
      const d = new Date(s.created_at || s.date || '')
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }).filter(Boolean)
  )
  const check = new Date(today)
  if (!dateSet.has(check.getTime())) check.setDate(check.getDate() - 1)
  let streak = 0
  while (dateSet.has(check.getTime())) { streak++; check.setDate(check.getDate() - 1) }
  return streak
}

/* Longest streak across the full history */
function calcLongestStreak(sessions) {
  if (!sessions.length) return 0
  const days = [...new Set(sessions.map(s => {
    const d = new Date(s.created_at || s.date || '')
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }).filter(Boolean))].sort((a, b) => a - b)
  let longest = 1, run = 1
  const DAY = 86400000
  for (let i = 1; i < days.length; i++) {
    if (days[i] - days[i - 1] === DAY) { run++; longest = Math.max(longest, run) }
    else run = 1
  }
  return longest
}

/* Most common flag type across a piece's takes */
function commonIssue(takes) {
  const counts = {}
  for (const t of takes) {
    for (const f of t.flags ?? []) {
      const type = (f.type ?? '').toLowerCase()
      if (type) counts[type] = (counts[type] || 0) + 1
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (!top) return null
  return top[0].charAt(0).toUpperCase() + top[0].slice(1)
}

function buildPieces(takes) {
  const map = {}
  for (const t of takes) {
    const key = t.piece_title || 'Untitled'
    if (!map[key]) map[key] = { title: key, composer: t.piece_composer || 'Unknown', instrument: t.instrument || '', takes: [] }
    map[key].takes.push(t)
  }
  return Object.values(map).map(p => ({
    ...p,
    latestScore: p.takes[0]?.score ?? null,
    latestDate:  p.takes[0]?.created_at ?? null,
    issue:       commonIssue(p.takes),
  })).sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate))
}

export default function Home() {
  const nav = useNavigate()
  const { setOpen } = useRecordModal()
  const takes = useTakes({ limit: 50 })
  const sessions = takes ?? []
  const loading = takes === undefined

  const streak = useMemo(() => calcStreak(sessions), [sessions])
  const longest = useMemo(() => calcLongestStreak(sessions), [sessions])
  const pieces = useMemo(() => buildPieces(sessions), [sessions])

  /* Recorded this week — sum duration of takes in the last 7 days */
  const weekMinutes = useMemo(() => {
    const cutoff = Date.now() - 7 * 86400000
    let totalSec = 0, count = 0
    for (const t of sessions) {
      const ts = new Date(t.created_at || t.date || '').getTime()
      if (ts >= cutoff) {
        count++
        totalSec += t.duration_sec ?? t.duration ?? 0
      }
    }
    return { totalSec, count }
  }, [sessions])

  const weekLabel = useMemo(() => {
    const total = weekMinutes.totalSec
    if (!total) return weekMinutes.count > 0 ? `${weekMinutes.count} rec` : '0m'
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }, [weekMinutes])

  /* Avg score — last 10 scored takes */
  const avgScore = useMemo(() => {
    const scored = sessions.filter(s => s.score != null).slice(0, 10)
    if (!scored.length) return null
    return Math.round(scored.reduce((sum, s) => sum + s.score, 0) / scored.length)
  }, [sessions])

  const lastTakeId = sessions[0]?.id

  return (
    <div className={styles.page}>
      {/* ── Hero card ── */}
      <div className={styles.hero}>
        <div className={styles.heroContent}>
          <span className={styles.heroLabel}>START HERE</span>
          <h1 className={styles.heroTitle}>Record a session. Get bar-by-bar feedback.</h1>
          <p className={styles.heroDesc}>
            Upload your performance and sheet music, and Mediant returns measure-level notes on
            pitch, rhythm, dynamics, and articulation.
          </p>
          <div className={styles.heroActions}>
            <button className={styles.heroPrimary} onClick={() => { playPop(); setOpen(true) }}>
              <MicIcon /> Record &amp; analyze
            </button>
            <button
              className={styles.heroSecondary}
              onClick={() => { playPop(); nav(lastTakeId ? `/analysis?takeId=${lastTakeId}` : '/analysis') }}
            >
              View last analysis →
            </button>
          </div>
        </div>
        <div className={styles.heroIconWrap}>
          <div className={styles.heroIconCircle}><MicIcon large /></div>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className={styles.statRow}>
        <div className={`${styles.statCard} ${styles.statSalmon}`}>
          <span className={styles.statLabel}>Streak</span>
          <span className={styles.statValue}>{streak}<span className={styles.statUnit}> {streak === 1 ? 'day' : 'days'}</span></span>
          <span className={styles.statSub}>Longest: {longest} {longest === 1 ? 'day' : 'days'}</span>
        </div>
        <div className={`${styles.statCard} ${styles.statYellow}`}>
          <span className={styles.statLabel}>Recorded this week</span>
          <span className={styles.statValue}>{weekLabel}</span>
          <span className={styles.statSub}>Across {weekMinutes.count} {weekMinutes.count === 1 ? 'session' : 'sessions'}</span>
        </div>
        <div className={`${styles.statCard} ${styles.statMint}`}>
          <span className={styles.statLabel}>Avg score</span>
          <span className={styles.statValue}>
            {avgScore != null ? avgScore : '—'}<span className={styles.statUnit}>/100</span>
          </span>
          <span className={styles.statSub}>Last 10 sessions</span>
        </div>
      </div>

      {/* ── My pieces ── */}
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>My pieces</h2>
        <button className={styles.sectionLink} onClick={() => { playPop(); nav('/sessions') }}>
          View all →
        </button>
      </div>

      {loading ? (
        <div className={styles.pieceGrid}>
          {[0, 1, 2].map(i => <div key={i} className={`${styles.pieceCard} ${styles.pieceSkeleton}`} />)}
        </div>
      ) : pieces.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No pieces yet</p>
          <p className={styles.emptyBody}>Record your first session and it will appear here.</p>
          <button className={styles.emptyBtn} onClick={() => { playPop(); setOpen(true) }}>
            <MicIcon /> Record &amp; analyze
          </button>
        </div>
      ) : (
        <div className={styles.pieceGrid}>
          {pieces.slice(0, 6).map((p, i) => (
            <button
              key={p.title + i}
              className={styles.pieceCard}
              onClick={() => {
                playPop()
                localStorage.setItem('mediant_selected_take', p.takes[0]?.id ?? '')
                nav(p.takes[0]?.id ? `/analysis?takeId=${p.takes[0].id}` : '/sessions')
              }}
            >
              <span className={styles.pieceScore} style={{ color: scoreColor(p.latestScore) }}>
                {p.latestScore != null ? p.latestScore : '—'}
              </span>
              <span className={styles.pieceTitle}>{p.title}</span>
              <span className={styles.pieceComposer}>
                {[p.composer, p.instrument].filter(Boolean).join(' · ')}
              </span>
              {p.issue && (
                <span className={styles.pieceIssue}>Most common issue: {p.issue}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Icons ── */
function MicIcon({ large }) {
  const s = large ? 30 : 15
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  )
}
