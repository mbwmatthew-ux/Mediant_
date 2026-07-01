import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTakes } from '../hooks/useTakes'
import Onboarding from '../components/Onboarding'
import MusicAmbience from '../components/MusicAmbience'
import styles from './Home.module.css'
import { playPop } from '../utils/sounds'

function formatDate() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function formatDateShort(iso) {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now - d
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays}d ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

function calcStreak(sessions) {
  if (!sessions.length) return 0
  const today = new Date(); today.setHours(0,0,0,0)
  const dateSet = new Set(
    sessions.map(s => {
      const d = new Date(s.created_at || s.date || '')
      d.setHours(0,0,0,0)
      return d.getTime()
    }).filter(Boolean)
  )
  const check = new Date(today)
  if (!dateSet.has(check.getTime())) check.setDate(check.getDate() - 1)
  let streak = 0
  while (dateSet.has(check.getTime())) { streak++; check.setDate(check.getDate() - 1) }
  return streak
}

function scoreColor(n) {
  if (n == null) return 'var(--text-faintest)'
  if (n >= 88) return 'var(--score-good)'
  if (n >= 74) return 'var(--score-ok)'
  return 'var(--score-bad)'
}

/* Group takes by piece into song threads */
function buildThreads(takes) {
  const map = {}
  for (const t of takes) {
    const key = t.piece_title || 'Untitled'
    if (!map[key]) map[key] = { title: key, composer: t.piece_composer || '', takes: [] }
    map[key].takes.push(t)
  }
  return Object.values(map).map(thread => ({
    ...thread,
    latestScore: thread.takes[0]?.score ?? null,
    prevScore:   thread.takes[1]?.score ?? null,
    latestDate:  thread.takes[0]?.created_at ?? null,
    takeCount:   thread.takes.length,
  })).sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate))
}

/* Build 7-day activity data */
function buildWeekActivity(sessions) {
  const days = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setHours(0,0,0,0)
    d.setDate(d.getDate() - i)
    const practiced = sessions.some(s => {
      const sd = new Date(s.created_at || '')
      sd.setHours(0,0,0,0)
      return sd.getTime() === d.getTime()
    })
    days.push({
      label: d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 1),
      practiced,
      isToday: i === 0,
    })
  }
  return days
}

export default function Home() {
  const nav = useNavigate()
  const { user } = useAuth()
  const takes = useTakes({ limit: 20 })
  const sessions = takes ?? []
  const [showOnboarding, setShowOnboarding] = useState(false)

  useEffect(() => {
    if (!user) return
    const serverDone = user.user_metadata?.onboarded === true
    const localDone  = !!localStorage.getItem('mediant_onboarded')
    if (!serverDone && !localDone) setShowOnboarding(true)
  }, [user])

  const loading = takes === undefined
  const streak  = useMemo(() => calcStreak(sessions), [sessions])
  const threads = useMemo(() => buildThreads(sessions), [sessions])
  const weekActivity = useMemo(() => buildWeekActivity(sessions), [sessions])

  const lastScore = sessions[0]?.score ?? null
  const prevScore = sessions[1]?.score ?? null
  const scoreDelta = lastScore != null && prevScore != null ? lastScore - prevScore : null

  const avgScore = useMemo(() => {
    const scored = sessions.filter(s => s.score != null)
    if (!scored.length) return null
    return Math.round(scored.reduce((sum, s) => sum + s.score, 0) / scored.length)
  }, [sessions])

  /* Technique trends */
  const techniqueTrends = useMemo(() => {
    const keys = ['timing', 'intonation', 'dynamics', 'articulation']
    const countFlags = (takeList) => {
      const c = Object.fromEntries(keys.map(k => [k, 0]))
      for (const t of takeList) {
        for (const f of t.flags ?? []) {
          const type = (f.type ?? '').toLowerCase()
          if (type in c) c[type]++
        }
      }
      return c
    }
    const newest = countFlags(sessions.slice(0, 3))
    const older  = countFlags(sessions.slice(3, 8))
    const labels = { timing: 'Timing', intonation: 'Intonation', dynamics: 'Dynamics', articulation: 'Articulation' }
    return keys.map(k => {
      const diff = sessions.length >= 4 ? older[k] - newest[k] : null
      const delta = diff === null ? null : diff
      return { label: labels[k], key: k, delta, improved: delta !== null && delta > 0 }
    })
  }, [sessions])

  /* Practice priorities from last take's flags */
  const priorities = useMemo(() => {
    const lastTake = sessions[0]
    if (!lastTake?.flags?.length) return []
    return lastTake.flags
      .filter(f => f.type && f.detail)
      .slice(0, 3)
      .map(f => ({
        text: f.detail?.slice(0, 90) || f.type,
        sub:  f.type ? `${f.type.charAt(0).toUpperCase() + f.type.slice(1)} · m.${f.measure}` : '',
        type: f.type,
      }))
  }, [sessions])

  /* Focus tip based on weakest trend */
  const focusTip = useMemo(() => {
    if (!sessions.length) return 'Upload your first recording to get personalized coaching feedback.'
    const worst = techniqueTrends.find(t => t.delta !== null && t.delta < 0)
    if (worst) return `Your ${worst.label.toLowerCase()} scores have dipped recently. Spend extra time on slow, isolated practice for those passages.`
    if (sessions[0]?.flags?.length) return `You have ${sessions[0].flags.length} flagged area${sessions[0].flags.length !== 1 ? 's' : ''} from your last session. Focus on those before recording again.`
    return 'Great consistency this week — keep the momentum going!'
  }, [sessions, techniqueTrends])

  const STAT_TILES = [
    {
      label: 'CURRENT STREAK',
      value: streak > 0 ? `${streak}` : '0',
      unit: streak === 1 ? 'day' : 'days',
      delta: streak > 1 ? `↑ +1` : null,
      deltaColor: 'var(--mint)',
    },
    {
      label: 'TOTAL SESSIONS',
      value: `${sessions.length}`,
      unit: sessions.length === 1 ? 'session' : 'sessions',
      delta: sessions.length > 0 ? null : null,
    },
    {
      label: 'AVG SCORE',
      value: avgScore != null ? `${avgScore}` : '—',
      unit: avgScore != null ? '/ 100' : '',
      delta: scoreDelta != null ? `${scoreDelta >= 0 ? '↑ +' : '↓ '}${scoreDelta}` : null,
      deltaColor: scoreDelta != null ? (scoreDelta >= 0 ? 'var(--mint)' : 'var(--coral)') : undefined,
    },
    {
      label: 'ACTIVE PIECES',
      value: `${threads.length}`,
      unit: threads.length === 1 ? 'piece' : 'pieces',
    },
  ]

  return (
    <div className={styles.page}>
      {showOnboarding && user && (
        <Onboarding onClose={() => setShowOnboarding(false)} />
      )}

      {/* ── Page header ── */}
      <div className={styles.pageHeader}>
        <MusicAmbience />
        <div className={styles.pageHeaderLeft}>
          <h1 className={styles.pageTitle}>Overview</h1>
          <p className={styles.pageSubtitle}>{formatDate()}</p>
        </div>
        <button className={styles.primaryBtn} onClick={() => { playPop(); nav('/record') }}>
          <PlusIcon /> New Session
        </button>
      </div>

      {/* ── Stat tiles ── */}
      <div className={styles.statTilesRow}>
        {STAT_TILES.map(tile => (
          <div key={tile.label} className={styles.statTile}>
            <span className={styles.statTileLabel}>{tile.label}</span>
            <div className={styles.statTileBottom}>
              <span className={styles.statTileValue}>
                {tile.value}
                {tile.unit && <span className={styles.statTileUnit}> {tile.unit}</span>}
              </span>
              {tile.delta && (
                <span className={styles.statTileDelta} style={{ color: tile.deltaColor }}>
                  {tile.delta}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── Main content ── */}
      <div className={styles.contentGrid}>

        {/* ── Left column ── */}
        <div className={styles.mainCol}>

          {/* Practice activity */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>Practice activity</span>
              <span className={styles.cardMeta}>Last 7 days</span>
            </div>
            <div className={styles.activityChart}>
              {weekActivity.map((day, i) => (
                <div key={i} className={styles.activityCol}>
                  <div className={styles.activityBarWrap}>
                    <div
                      className={`${styles.activityBar} ${day.practiced ? styles.activityBarFilled : ''} ${day.isToday ? styles.activityBarToday : ''}`}
                    />
                  </div>
                  <span className={`${styles.activityDayLabel} ${day.isToday ? styles.activityDayToday : ''}`}>
                    {day.label}
                  </span>
                </div>
              ))}
            </div>
            <div className={styles.activityFooter}>
              <span className={styles.activityLegend}>
                <span className={styles.activityDot} /> Practiced
              </span>
              <span className={styles.activityGoal}>Goal · 1 session / day</span>
            </div>
          </div>

          {/* Recent sessions */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>Recent sessions</span>
              <button className={styles.viewAllBtn} onClick={() => { playPop(); nav('/takes') }}>
                View all →
              </button>
            </div>

            {loading ? (
              <div className={styles.tableEmpty}>Loading…</div>
            ) : threads.length === 0 ? (
              <div className={styles.tableEmpty}>
                No sessions yet —{' '}
                <button className={styles.inlineLink} onClick={() => { playPop(); nav('/record') }}>
                  upload your first recording
                </button>
              </div>
            ) : (
              <table className={styles.sessionsTable}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Piece</th>
                    <th>Score</th>
                    <th>Takes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {threads.slice(0, 6).map((thread, i) => {
                    const delta = thread.latestScore != null && thread.prevScore != null
                      ? thread.latestScore - thread.prevScore
                      : null
                    return (
                      <tr
                        key={thread.title + i}
                        className={styles.sessionRow}
                        onClick={() => { playPop(); nav(`/takes?piece=${encodeURIComponent(thread.title)}`) }}
                      >
                        <td className={styles.sessionDate}>{formatDateShort(thread.latestDate)}</td>
                        <td className={styles.sessionPiece}>
                          <span className={styles.sessionPieceTitle}>{thread.title}</span>
                          {thread.composer && <span className={styles.sessionComposer}>{thread.composer}</span>}
                        </td>
                        <td className={styles.sessionScore}>
                          {thread.latestScore != null ? (
                            <span style={{ color: scoreColor(thread.latestScore), fontWeight: 700 }}>
                              {thread.latestScore}
                            </span>
                          ) : '—'}
                          {delta != null && (
                            <span className={styles.sessionDelta}
                              style={{ color: delta >= 0 ? 'var(--mint)' : 'var(--coral)' }}>
                              {delta >= 0 ? ` ↑ +${delta}` : ` ↓ ${delta}`}
                            </span>
                          )}
                        </td>
                        <td className={styles.sessionTakes}>{thread.takeCount}</td>
                        <td className={styles.sessionChevron}>›</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── Right column ── */}
        <div className={styles.sideCol}>

          {/* Today's plan */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>Today's plan</span>
            </div>
            {priorities.length > 0 ? (
              <div className={styles.planList}>
                {priorities.map((p, i) => (
                  <div key={i} className={styles.planItem}>
                    <div className={styles.planItemNum}>{i + 1}</div>
                    <div className={styles.planItemContent}>
                      <p className={styles.planItemText}>{p.text}</p>
                      {p.sub && <span className={styles.planItemSub}>{p.sub}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.sideEmpty}>
                {sessions.length > 0
                  ? 'No recurring issues — record a new take to refresh your plan.'
                  : 'Upload a recording to see a personalized practice plan.'}
              </p>
            )}
            <button className={styles.recordBtn} onClick={() => { playPop(); nav('/record') }}>
              <MicIcon /> Record new take
            </button>
          </div>

          {/* Technique trends */}
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>Technique trends</span>
            </div>
            <div className={styles.trendList}>
              {techniqueTrends.map(t => (
                <div key={t.key} className={styles.trendRow}>
                  <span className={styles.trendLabel}>{t.label}</span>
                  <span className={styles.trendDelta}
                    style={{
                      color: t.delta === null ? 'var(--text-faintest)'
                        : t.improved ? 'var(--mint)' : 'var(--coral)'
                    }}>
                    {t.delta === null ? '—' : t.improved ? `↑ +${t.delta}%` : `↓ ${t.delta}%`}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* This week's focus */}
          <div className={`${styles.card} ${styles.focusCard}`}>
            <div className={styles.focusCardLabel}>
              <StarIcon /> THIS WEEK'S FOCUS
            </div>
            <p className={styles.focusTip}>{focusTip}</p>
          </div>

        </div>
      </div>
    </div>
  )
}

/* ── Icons ─────────────────────────────── */
function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  )
}
function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  )
}
function StarIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
    </svg>
  )
}
