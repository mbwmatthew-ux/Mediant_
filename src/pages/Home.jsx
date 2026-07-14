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

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts).getTime()
  const d = Math.floor(diff / 86400000)
  if (d === 0) return 'Today'
  if (d === 1) return 'Yesterday'
  return `${d}d ago`
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

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
        totalSec += t.duration_seconds ?? t.duration ?? 0
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

  const recurringIssues = useMemo(() => {
    const byType = {}
    for (const t of sessions) {
      for (const f of t.flags ?? []) {
        const type = (f.type ?? 'other').toLowerCase()
        if (!byType[type]) byType[type] = { type, titles: [], pieces: new Set(), takeIds: new Set() }
        byType[type].titles.push(f.title ?? '')
        byType[type].pieces.add(t.piece_title ?? 'Unknown')
        byType[type].takeIds.add(t.id)
      }
    }
    return Object.values(byType)
      .filter(g => g.takeIds.size >= 2)
      .sort((a, b) => b.takeIds.size - a.takeIds.size)
      .slice(0, 3)
  }, [sessions])

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
          <div className={styles.statCardTop}>
            <span className={styles.statLabel}>Streak</span>
            <FlameIcon />
          </div>
          <span className={styles.statValue}>{streak}<span className={styles.statUnit}> {streak === 1 ? 'day' : 'days'}</span></span>
          <span className={styles.statSub}>Longest: {longest} {longest === 1 ? 'day' : 'days'}</span>
        </div>
        <div className={`${styles.statCard} ${styles.statYellow}`}>
          <div className={styles.statCardTop}>
            <span className={styles.statLabel}>Recorded this week</span>
            <ClockIcon />
          </div>
          <span className={styles.statValue}>{weekLabel}</span>
          <span className={styles.statSub}>Across {weekMinutes.count} {weekMinutes.count === 1 ? 'session' : 'sessions'}</span>
        </div>
        <div className={`${styles.statCard} ${styles.statMint}`}>
          <div className={styles.statCardTop}>
            <span className={styles.statLabel}>Avg score</span>
            <GaugeIcon />
          </div>
          <span className={styles.statValue}>
            {avgScore != null ? avgScore : '—'}<span className={styles.statUnit}>/100</span>
          </span>
          <span className={styles.statSub}>Last 10 sessions</span>
        </div>
      </div>

      {/* ── Recurring issues ── */}
      {recurringIssues.length > 0 && (
        <div className={styles.recurringCard}>
          <div className={styles.recurringHead}>
            <div>
              <h2 className={styles.recurringTitle}>Recurring issues</h2>
              <p className={styles.recurringSubtitle}>Patterns Mediant has noticed across your analyses.</p>
            </div>
            <span className={styles.recurringFrom}>From your last {sessions.length} recordings</span>
          </div>
          {recurringIssues.map((issue, i) => (
            <div key={i} className={styles.recurringItem}>
              <div className={styles.recurringItemIcon}>
                <RecurringIcon type={issue.type} />
              </div>
              <div className={styles.recurringItemBody}>
                <span className={styles.recurringItemTitle}>{capitalize(issue.type)} flagged in your last {issue.takeIds.size} sessions</span>
                <span className={styles.recurringItemSub}>{[...issue.pieces].join(', ')} — {issue.titles[0]}</span>
              </div>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-faint)', flexShrink: 0 }}>
                <line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>
              </svg>
            </div>
          ))}
        </div>
      )}

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
              <div className={styles.pieceCardTop}>
                <span className={styles.pieceIconCircle}><MusicNoteIcon /></span>
                <span className={styles.pieceScore} style={{ color: scoreColor(p.latestScore) }}>
                  {p.latestScore != null ? p.latestScore : '—'}
                </span>
              </div>
              <span className={styles.pieceTitle}>{p.title}</span>
              <span className={styles.pieceDate}>{timeAgo(p.latestDate)} · last analysis</span>
              {p.issue && (
                <>
                  <div className={styles.pieceDivider} />
                  <span className={styles.pieceIssue}>Most common issue: {p.issue}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Icons ── */
function FlameIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
}
function ClockIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
}
function GaugeIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10"/><path d="M12 16a4 4 0 0 0 0-8"/><path d="M12 12l3-3"/></svg>
}
function RecurringIcon({ type }) {
  if (type === 'timing' || type === 'rhythm') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg>
  if (type === 'intonation') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
}

function MusicNoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  )
}

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
