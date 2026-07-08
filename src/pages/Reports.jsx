import { useMemo } from 'react'
import { useTakes } from '../hooks/useTakes'
import { useRecordModal } from '../context/RecordModalContext'
import styles from './Reports.module.css'
import { playPop } from '../utils/sounds'

const SKILL_DIMS = [
  { key: 'intonation',   label: 'Intonation',       keys: ['intonation'] },
  { key: 'timing',       label: 'Rhythm & timing',  keys: ['timing', 'rhythm'] },
  { key: 'dynamics',     label: 'Dynamics',         keys: ['dynamics'] },
  { key: 'articulation', label: 'Articulation',     keys: ['articulation'] },
  { key: 'tone',         label: 'Tone',             keys: ['tone', 'phrasing', 'expression'] },
]

function scoreColor(n) {
  if (n == null) return 'var(--text-faint)'
  if (n >= 90) return 'var(--score-good)'
  if (n >= 74) return 'var(--score-ok)'
  return 'var(--score-bad)'
}

function computeSkill(takes, dim) {
  const scored = takes.filter(t => t.score != null)
  if (!scored.length) return null
  const avg = Math.round(scored.reduce((s, t) => s + t.score, 0) / scored.length)
  const flags = scored.flatMap(t => (t.flags ?? []).filter(f => dim.keys.includes((f.type ?? '').toLowerCase())))
  const weight = flags.reduce((s, f) => s + (f.confidence ?? 80) / 100, 0)
  const deduction = Math.round(weight * 8)
  const bonus = flags.length === 0 ? 5 : 0
  return Math.max(20, Math.min(100, avg - deduction + bonus))
}

function getMonthLabel(monthsAgo) {
  const d = new Date()
  d.setMonth(d.getMonth() - monthsAgo)
  return d.toLocaleDateString('en-US', { month: 'short' })
}

/* Build 6-month average-score trend */
function buildMonthlyAvg(takes) {
  const months = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59)
    const monthTakes = takes.filter(t => {
      const td = new Date(t.created_at || t.date || '')
      return td >= start && td <= end && t.score != null
    })
    let score = null
    if (monthTakes.length > 0) {
      score = Math.round(monthTakes.reduce((s, t) => s + t.score, 0) / monthTakes.length)
    }
    months.push({ label: getMonthLabel(i), score })
  }
  return months
}

const AI_INSIGHTS = [
  { icon: 'up',   title: 'Rhythmic control is trending up', body: 'Your timing flags have dropped over the past month — subdivided practice is paying off.' },
  { icon: 'dot',  title: 'Intonation is your steadiest skill', body: 'Pitch accuracy holds consistently high across pieces. Keep long-tone warmups in your routine.' },
  { icon: 'flag', title: 'Dynamics need the most attention', body: 'Contrast between soft and loud passages is where most flags cluster. Practice dynamic extremes in isolation.' },
]

export default function Reports() {
  const { setOpen } = useRecordModal()
  const rawTakes = useTakes({ limit: 200 })
  const takes = rawTakes ?? []
  const loading = rawTakes === undefined

  const monthly = useMemo(() => buildMonthlyAvg(takes), [takes])

  const currentAvg = useMemo(() => {
    const scored = takes.filter(t => t.score != null)
    if (!scored.length) return null
    return Math.round(scored.reduce((s, t) => s + t.score, 0) / scored.length)
  }, [takes])

  /* delta vs last month */
  const monthDelta = useMemo(() => {
    const withScore = monthly.filter(m => m.score != null)
    if (withScore.length < 2) return null
    const last = withScore[withScore.length - 1].score
    const prev = withScore[withScore.length - 2].score
    return last - prev
  }, [monthly])

  /* Skill bars with deltas (recent half vs earlier half) */
  const skills = useMemo(() => {
    const recent  = takes.slice(0, Math.ceil(takes.length / 2))
    const earlier = takes.slice(Math.ceil(takes.length / 2))
    return SKILL_DIMS.map(dim => {
      const score = computeSkill(takes, dim)
      const r = computeSkill(recent, dim)
      const e = computeSkill(earlier, dim)
      const delta = r != null && e != null ? r - e : null
      return { ...dim, score, delta }
    })
  }, [takes])

  /* Build SVG polyline geometry */
  const chart = useMemo(() => {
    const W = 640, H = 220, padX = 24, padY = 24
    const pts = monthly.map((m, i) => {
      const x = padX + (i / (monthly.length - 1 || 1)) * (W - padX * 2)
      const v = m.score == null ? 60 : m.score
      const y = padY + (1 - (v - 40) / 60) * (H - padY * 2)
      return { x, y, ...m }
    })
    const line = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    const area = `${padX},${H - padY} ${line} ${W - padX},${H - padY}`
    return { W, H, pts, line, area }
  }, [monthly])

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Your progress</h1>

      {/* ── Large score card + chart ── */}
      <div className={styles.scoreCard}>
        <div className={styles.scoreHead}>
          <div>
            <span className={styles.scoreLabel}>Average score · last 6 months</span>
            <div className={styles.scoreBig}>
              <span style={{ color: scoreColor(currentAvg) }}>{currentAvg != null ? currentAvg : '—'}</span>
              {monthDelta != null && (
                <span className={styles.scoreDelta} style={{ color: monthDelta >= 0 ? 'var(--score-good)' : 'var(--score-bad)' }}>
                  {monthDelta >= 0 ? `+${monthDelta}` : monthDelta} vs last month
                </span>
              )}
            </div>
          </div>
        </div>

        {/* SVG chart */}
        <svg className={styles.chart} viewBox={`0 0 ${chart.W} ${chart.H}`} preserveAspectRatio="none" role="img" aria-label="Average score trend">
          <polygon points={chart.area} fill="rgba(17,112,128,0.15)" />
          <polyline points={chart.line} fill="none" stroke="var(--score-good)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {chart.pts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="4.5" fill="#fff" stroke="var(--score-good)" strokeWidth="2.5" />
          ))}
        </svg>

        {/* Month labels + values */}
        <div className={styles.chartAxis}>
          {monthly.map((m, i) => (
            <div key={i} className={styles.axisCol}>
              <span className={styles.axisMonth}>{m.label}</span>
              <span className={styles.axisValue}>{m.score != null ? m.score : '—'}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── By skill ── */}
      <h2 className={styles.sectionTitle}>By skill</h2>
      <div className={styles.skillCard}>
        {skills.map(s => (
          <div key={s.key} className={styles.skillRow}>
            <span className={styles.skillLabel}>{s.label}</span>
            <div className={styles.skillBarTrack}>
              <div
                className={styles.skillBarFill}
                style={{ width: `${s.score ?? 0}%`, background: scoreColor(s.score) }}
              />
            </div>
            <span className={styles.skillScore} style={{ color: scoreColor(s.score) }}>
              {s.score != null ? s.score : '—'}
            </span>
            <span
              className={styles.skillDelta}
              style={{ color: s.delta == null ? 'var(--text-faintest)' : s.delta >= 0 ? 'var(--score-good)' : 'var(--score-bad)' }}
            >
              {s.delta == null ? '' : s.delta >= 0 ? `+${s.delta}` : s.delta}
            </span>
          </div>
        ))}
      </div>

      {/* ── Overall feedback ── */}
      <h2 className={styles.sectionTitle}>Overall feedback</h2>
      <div className={styles.insightList}>
        {AI_INSIGHTS.map((ins, i) => (
          <div key={i} className={styles.insightRow}>
            <span className={styles.insightIcon}><InsightIcon type={ins.icon} /></span>
            <div>
              <p className={styles.insightTitle}>{ins.title}</p>
              <p className={styles.insightBody}>{ins.body}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Suggested focus banner ── */}
      <div className={styles.focusBanner}>
        <div>
          <span className={styles.focusLabel}>SUGGESTED FOCUS THIS WEEK</span>
          <p className={styles.focusText}>
            {loading
              ? 'Loading your practice history…'
              : 'Spend two sessions on dynamic contrast — play each passage once pp, once ff, then find the midpoint.'}
          </p>
        </div>
        <button className={styles.focusBtn} onClick={() => { playPop(); setOpen(true) }}>
          Record now
        </button>
      </div>
    </div>
  )
}

function InsightIcon({ type }) {
  if (type === 'up') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
      </svg>
    )
  }
  if (type === 'flag') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  )
}
