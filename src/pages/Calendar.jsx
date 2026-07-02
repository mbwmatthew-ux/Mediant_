import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTakes } from '../hooks/useTakes'
import styles from './Calendar.module.css'
import { playPop } from '../utils/sounds'

const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfWeek(year, month) {
  return new Date(year, month, 1).getDay()
}

function dateKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export default function Calendar() {
  const nav = useNavigate()
  const takes = useTakes({ limit: 200 })
  const sessions = takes ?? []

  const today = new Date()
  const [viewYear,  setViewYear]  = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())

  /* Build set of days that have practice sessions */
  const sessionsByDay = useMemo(() => {
    const map = {}
    sessions.forEach(s => {
      const d = new Date(s.created_at || '')
      if (isNaN(d)) return
      const key = dateKey(d)
      if (!map[key]) map[key] = []
      map[key].push(s)
    })
    return map
  }, [sessions])

  /* Find the most recent completed take that has a practice plan */
  const latestPlan = useMemo(() => {
    const withPlan = sessions.find(s => s.practice_plan?.days?.length && s.created_at)
    if (!withPlan) return null
    const analysisDate = new Date(withPlan.created_at)
    analysisDate.setHours(0, 0, 0, 0)
    return {
      plan: withPlan.practice_plan,
      pieceTitle: withPlan.piece_title,
      analysisDate,
    }
  }, [sessions])

  /* Build map: dateKey → plan day object */
  const planByDay = useMemo(() => {
    if (!latestPlan) return {}
    const map = {}
    latestPlan.plan.days.forEach(d => {
      const dayDate = new Date(latestPlan.analysisDate)
      dayDate.setDate(dayDate.getDate() + d.day) // Day 1 = day after analysis
      map[dateKey(dayDate)] = d
    })
    return map
  }, [latestPlan])

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11) }
    else setViewMonth(m => m - 1)
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0) }
    else setViewMonth(m => m + 1)
  }

  const daysInMonth    = getDaysInMonth(viewYear, viewMonth)
  const firstDayOfWeek = getFirstDayOfWeek(viewYear, viewMonth)

  const cells = []
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  const monthLabel = new Date(viewYear, viewMonth).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric'
  })

  const practiceDaysThisMonth = Object.keys(sessionsByDay).filter(key => {
    const parts = key.split('-')
    return parseInt(parts[0]) === viewYear && parseInt(parts[1]) === viewMonth
  }).length

  return (
    <div className={styles.page}>

      {/* ── Page header ── */}
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderLeft}>
          <h1 className={styles.pageTitle}>Practice Calendar</h1>
          <p className={styles.pageSubtitle}>{monthLabel}</p>
        </div>
        <div className={styles.headerRight}>
          <button className={styles.navBtn} onClick={prevMonth} title="Previous month">‹</button>
          <button className={styles.navBtn} onClick={nextMonth} title="Next month">›</button>
          <button className={styles.primaryBtn} onClick={() => { playPop(); nav('/record') }}>
            + New session
          </button>
        </div>
      </div>

      {/* ── Stats strip ── */}
      <div className={styles.statsStrip}>
        <div className={styles.statItem}>
          <span className={styles.statValue}>{practiceDaysThisMonth}</span>
          <span className={styles.statLabel}>Practice days this month</span>
        </div>
        <div className={styles.statDivider} />
        <div className={styles.statItem}>
          <span className={styles.statValue}>{sessions.length}</span>
          <span className={styles.statLabel}>Total sessions</span>
        </div>
        <div className={styles.statDivider} />
        <div className={styles.statItem}>
          <span className={styles.statValue}>
            {sessions.length > 0
              ? Math.round(sessions.filter(s => s.score != null).reduce((sum, s) => sum + s.score, 0) /
                  Math.max(1, sessions.filter(s => s.score != null).length))
              : '—'}
          </span>
          <span className={styles.statLabel}>Avg score</span>
        </div>
      </div>

      {/* ── Practice plan banner ── */}
      {latestPlan && (
        <div className={styles.planBanner}>
          <span className={styles.planBannerIcon}>📋</span>
          <div>
            <span className={styles.planBannerTitle}>AI Practice Plan — {latestPlan.pieceTitle}</span>
            <span className={styles.planBannerSub}>{latestPlan.plan.summary}</span>
          </div>
        </div>
      )}

      {/* ── Calendar grid ── */}
      <div className={styles.calendarBody}>
        <div className={styles.dayLabels}>
          {DAY_LABELS.map(l => (
            <div key={l} className={styles.dayLabel}>{l}</div>
          ))}
        </div>

        <div className={styles.grid}>
          {cells.map((d, i) => {
            if (d === null) return <div key={`e-${i}`} className={styles.emptyCell} />

            const isToday = d === today.getDate()
              && viewMonth === today.getMonth()
              && viewYear  === today.getFullYear()
            const key         = `${viewYear}-${viewMonth}-${d}`
            const daySessions = sessionsByDay[key] ?? []
            const hasPractice = daySessions.length > 0
            const planDay     = planByDay[key]

            return (
              <div key={d} className={`${styles.dayCell} ${isToday ? styles.dayCellToday : ''} ${planDay ? styles.dayCellPlan : ''}`}>
                <span className={`${styles.dayNum} ${isToday ? styles.dayNumToday : ''}`}>{d}</span>

                {hasPractice && (
                  <button
                    className={styles.practiceTag}
                    onClick={() => { playPop(); nav('/analysis') }}
                  >
                    Practice
                    {daySessions.length > 1 && (
                      <span className={styles.practiceCount}>×{daySessions.length}</span>
                    )}
                  </button>
                )}

                {hasPractice && (() => {
                  const best = daySessions.reduce((b, s) =>
                    s.score != null && (b == null || s.score > b) ? s.score : b, null)
                  return best != null ? (
                    <span className={styles.dayScore}>{best}</span>
                  ) : null
                })()}

                {/* AI practice plan task for this day */}
                {planDay && !hasPractice && (
                  <div className={styles.planDayTag} title={planDay.tasks?.map(t => t.title).join(' · ')}>
                    <span className={styles.planDayLabel}>{planDay.label}</span>
                    <span className={styles.planDayMins}>{planDay.total_minutes}m</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Practice plan detail panel ── */}
      {latestPlan && (
        <div className={styles.planPanel}>
          <h3 className={styles.planPanelTitle}>This week's plan — {latestPlan.pieceTitle}</h3>
          <div className={styles.planDays}>
            {latestPlan.plan.days.map(d => {
              const dayDate = new Date(latestPlan.analysisDate)
              dayDate.setDate(dayDate.getDate() + d.day)
              const isPast = dayDate < today
              const isCurrentDay = dateKey(dayDate) === dateKey(today)
              return (
                <div key={d.day} className={`${styles.planDayCard} ${isPast ? styles.planDayCardPast : ''} ${isCurrentDay ? styles.planDayCardToday : ''}`}>
                  <div className={styles.planDayCardHead}>
                    <span className={styles.planDayCardLabel}>
                      {isCurrentDay ? 'Today' : dayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </span>
                    <span className={styles.planDayCardFocus}>{d.label}</span>
                    <span className={styles.planDayCardMins}>{d.total_minutes}m</span>
                  </div>
                  <ul className={styles.planTaskList}>
                    {(d.tasks ?? []).map((t, ti) => (
                      <li key={ti} className={styles.planTask}>
                        <span className={styles.planTaskTitle}>{t.title}</span>
                        {t.measure && <span className={styles.planTaskMeasure}>m.{t.measure}</span>}
                        <span className={styles.planTaskDesc}>{t.description}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Recent sessions list ── */}
      {sessions.length > 0 && (
        <div className={styles.recentSection}>
          <h3 className={styles.recentTitle}>Recent sessions</h3>
          <div className={styles.recentList}>
            {sessions.slice(0, 5).map((s, i) => {
              const d = new Date(s.created_at || '')
              const dateLabel = isNaN(d) ? '' : d.toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric'
              })
              return (
                <div key={s.id ?? i} className={styles.recentRow}
                  onClick={() => { playPop(); nav('/analysis') }}>
                  <span className={styles.recentDate}>{dateLabel}</span>
                  <span className={styles.recentPiece}>
                    {s.piece_title || 'Untitled'}
                    {s.piece_composer ? ` · ${s.piece_composer}` : ''}
                  </span>
                  {s.score != null && (
                    <span className={styles.recentScore}
                      style={{ color: s.score >= 88 ? 'var(--mint)' : s.score >= 74 ? 'var(--accent)' : 'var(--coral)' }}>
                      {s.score}
                    </span>
                  )}
                  <span className={styles.recentChevron}>›</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
