import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTakes } from '../hooks/useTakes'
import { useRecordModal } from '../context/RecordModalContext'
import { usePrefersReducedMotion, useMounted, useCountUp } from '../hooks/useMotion'
import styles from './Home.module.css'
import { playPop } from '../utils/sounds'

/* Monthly goal for the ring. One number, so the ring, the "18 / 25" row and the
   percentage can never disagree. */
const MONTHLY_GOAL = 25

const TYPE_LABEL = {
  intonation: 'Intonation', rhythm: 'Rhythm', timing: 'Timing',
  dynamics: 'Dynamics', articulation: 'Articulation', tone: 'Tone',
  phrasing: 'Phrasing', posture: 'Posture', technique: 'Technique',
  error: 'Wrong notes', voicing: 'Voicing',
}

const FOCUS_BY_TYPE = {
  intonation:   { name: 'Long-tone tuning',     hint: 'Steady pitch against a drone' },
  rhythm:       { name: 'Subdivided metronome', hint: 'Lock the inner pulse' },
  timing:       { name: 'Metronome anchoring',  hint: 'Hold one tempo end to end' },
  dynamics:     { name: 'Terraced dynamics',    hint: 'Widen your soft-to-loud range' },
  articulation: { name: 'Detached attacks',     hint: 'Cleaner starts to each note' },
  tone:         { name: 'Sustained tone',       hint: 'Even colour through the phrase' },
  phrasing:     { name: 'Smooth legato',        hint: 'Improve connection between notes' },
  technique:    { name: 'Slow-tempo drilling',  hint: 'Build accuracy before speed' },
  posture:      { name: 'Setup and balance',    hint: 'Release tension while you play' },
  error:        { name: 'Note accuracy',        hint: 'Slow passes with the score open' },
}
const DEFAULT_FOCUS = { name: 'Smooth legato', hint: 'Improve connection between notes' }

function timeLabel(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const day = new Date(d); day.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diff = Math.round((today - day) / 86400000)
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (diff === 0) return `Today  ·  ${clock}`
  if (diff === 1) return `Yesterday  ·  ${clock}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}  ·  ${clock}`
}

function calcStreak(sessions) {
  if (!sessions.length) return 0
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const set = new Set(sessions.map(s => {
    const d = new Date(s.created_at || s.date || '')
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }).filter(n => !Number.isNaN(n)))
  const check = new Date(today)
  if (!set.has(check.getTime())) check.setDate(check.getDate() - 1)
  let streak = 0
  while (set.has(check.getTime())) { streak++; check.setDate(check.getDate() - 1) }
  return streak
}

export default function Home() {
  const nav = useNavigate()
  const { setOpen } = useRecordModal()
  const takes = useTakes({ limit: 60 })
  const loading = takes === undefined
  const sessions = useMemo(() => takes ?? [], [takes])
  const reduced = usePrefersReducedMotion()
  const shown = useMounted()

  const monthCount = useMemo(() => {
    const now = new Date()
    return sessions.filter(s => {
      const d = new Date(s.created_at || s.date || '')
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    }).length
  }, [sessions])

  const avgScore = useMemo(() => {
    const scored = sessions.filter(s => s.score != null).slice(0, 10)
    if (!scored.length) return null
    return Math.round(scored.reduce((sum, s) => sum + s.score, 0) / scored.length)
  }, [sessions])

  const streak = useMemo(() => calcStreak(sessions), [sessions])
  const ringPct = Math.min(100, Math.round((monthCount / MONTHLY_GOAL) * 100))

  const scoreTrend = useMemo(() => {
    const s = sessions.filter(t => t.score != null).slice(0, 8).map(t => t.score).reverse()
    return s.length >= 2 ? s : []
  }, [sessions])

  /* Scored takes inside the current calendar month, so "this month" is true. */
  const monthTrend = useMemo(() => {
    const now = new Date()
    const s = sessions.filter(t => {
      if (t.score == null) return false
      const d = new Date(t.created_at || t.date || '')
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    }).map(t => t.score).reverse()
    return s.length >= 2 ? s : []
  }, [sessions])

  const improved = useMemo(() => {
    const withFlags = sessions.filter(t => Array.isArray(t.flags))
    const delta = monthTrend.length >= 2
      ? Math.round(monthTrend[monthTrend.length - 1] - monthTrend[0]) : null
    if (withFlags.length < 4) return { label: null, delta }
    const half = Math.floor(withFlags.length / 2)
    const recent = withFlags.slice(0, half)
    const older  = withFlags.slice(half)
    const share = (g, ty) =>
      g.filter(t => t.flags.some(f => (f.type ?? '').toLowerCase() === ty)).length / (g.length || 1)
    const types = new Set()
    for (const t of withFlags) for (const f of t.flags) {
      const ty = (f.type ?? '').toLowerCase()
      if (ty && TYPE_LABEL[ty]) types.add(ty)
    }
    let best = null
    for (const ty of types) {
      const drop = share(older, ty) - share(recent, ty)
      if (drop > 0.15 && (!best || drop > best.drop)) best = { type: ty, drop }
    }
    return { label: best ? TYPE_LABEL[best.type] : null, delta }
  }, [sessions, monthTrend])

  const hearing = useMemo(() => {
    const withFlags = sessions.filter(t => Array.isArray(t.flags) && t.flags.length)
    if (!withFlags.length) return []
    const counts = {}
    for (const t of withFlags) {
      const seen = new Set()
      for (const f of t.flags) {
        const ty = (f.type ?? '').toLowerCase()
        if (!ty || !TYPE_LABEL[ty] || seen.has(ty)) continue
        seen.add(ty)
        if (!counts[ty]) counts[ty] = { type: ty, takes: 0, example: f.title ?? '' }
        counts[ty].takes++
      }
    }
    return Object.values(counts).map(c => {
      const pct = c.takes / withFlags.length
      return {
        ...c,
        freq: pct >= 0.6 ? 'Appears often' : pct >= 0.3 ? 'Sometimes' : 'Rarely',
        tone: pct >= 0.6 ? 'high' : pct >= 0.3 ? 'mid' : 'low',
      }
    }).sort((a, b) => b.takes - a.takes).slice(0, 4)
  }, [sessions])

  const focus = useMemo(() => {
    const top = hearing[0]
    return (top && FOCUS_BY_TYPE[top.type]) || DEFAULT_FOCUS
  }, [hearing])

  const recent = sessions.slice(0, 4)
  const hasHistory = sessions.length > 0

  const ringValue  = useCountUp(shown ? ringPct : 0, { reduced, duration: 1200 })
  const countValue = useCountUp(shown ? monthCount : 0, { reduced, duration: 900 })
  const scoreValue = useCountUp(shown && avgScore != null ? avgScore : 0, { reduced, duration: 1000 })

  return (
    <div className={`${styles.page} ${reduced ? styles.noMotion : ''}`}>

      {/* ══ ROW 1 — progress | most improved | up next ═════════════════════ */}
      <section className={styles.rowTop}>

        <article className={`${styles.card} ${styles.progressCard}`} style={{ '--d': '0ms' }}>
          <header className={styles.cardHead}>
            <span className={styles.cardIcon}><BarsIcon /></span>
            <h2 className={styles.cardTitle}>Your progress</h2>
          </header>

          <div className={styles.progressBody}>
            <Ring pct={ringValue} label={Math.round(ringValue)} shown={shown} reduced={reduced} />
            <div className={styles.metrics}>
              <Metric icon={<CheckIcon />} tone="green" label="Sessions recorded"
                      value={Math.round(countValue)} suffix={`/ ${MONTHLY_GOAL}`}
                      fill={shown ? Math.min(100, (monthCount / MONTHLY_GOAL) * 100) : 0} delay={200} />
              <Metric icon={<StarIcon />} tone="gold" label="Average score"
                      value={avgScore != null ? Math.round(scoreValue) : '—'}
                      suffix={avgScore != null ? '/ 100' : null}
                      fill={shown && avgScore != null ? avgScore : 0} delay={280} />
              <Metric icon={<TargetIcon />} tone="lav" label="Streak"
                      value={streak} suffix={streak === 1 ? 'day' : 'days'}
                      trailing={streak >= 3 ? '🔥' : null}
                      fill={shown ? Math.min(100, (streak / 7) * 100) : 0} delay={360} />
            </div>
          </div>

          <p className={styles.progressNote}>
            {monthCount === 0
              ? 'Record your first session this month to start the streak.'
              : streak >= 3
                ? 'You’re building great habits. Keep going! 🎉'
                : 'Steady progress — a short session today keeps it moving.'}
          </p>
        </article>

        <article className={`${styles.card} ${styles.improvedCard}`} style={{ '--d': '70ms' }}>
          <span className={styles.improvedEyebrow}>MOST IMPROVED</span>
          <h2 className={styles.improvedTitle}>
            {improved.label ?? (scoreTrend.length ? 'Overall score' : 'Getting started')}
          </h2>
          {improved.delta != null && improved.delta > 0 && (
            <span className={styles.improvedDelta}>+{improved.delta} points this month</span>
          )}
          <p className={styles.improvedBody}>
            {improved.label
              ? `Nice work — ${improved.label.toLowerCase()} is showing up in fewer of your recent takes.`
              : scoreTrend.length
                ? 'Your scores are trending in the right direction — keep the sessions coming.'
                : 'Record a few sessions and Mediant will start tracking what improves.'}
          </p>

          <Sparkline points={scoreTrend} shown={shown} reduced={reduced} />

          {hasHistory && (
            <>
              <button className={styles.improvedBtn} onClick={() => { playPop(); nav('/reports') }}>
                View detailed progress <ChevronIcon />
              </button>
              <span className={styles.trophy} aria-hidden="true">🏆</span>
            </>
          )}
        </article>

        <article className={`${styles.card} ${styles.nextCard}`} style={{ '--d': '140ms' }}>
          <span className={styles.nextEyebrow}>UP NEXT</span>
          <h2 className={styles.nextTitle}>Try a focused session</h2>
          <p className={styles.nextSub}>Pick a goal and record 5–10 minutes.</p>

          <button className={styles.focusRow} onClick={() => { playPop(); setOpen(true) }}>
            <span className={styles.focusIcon}><ClipIcon /></span>
            <span className={styles.focusText}>
              <span className={styles.focusName}>{focus.name}</span>
              <span className={styles.focusHint}>{focus.hint}</span>
            </span>
            <ChevronIcon />
          </button>

          <span className={styles.clipboard} aria-hidden="true"><Clipboard /></span>
        </article>
      </section>

      {/* ══ ROW 2 — what we're hearing | recent sessions ═══════════════════ */}
      <section className={styles.rowBottom}>

        <article className={`${styles.card} ${styles.hearingCard}`} style={{ '--d': '210ms' }}>
          <header className={styles.cardHead}>
            <span className={`${styles.cardIcon} ${styles.cardIconCoral}`}><EarIcon /></span>
            <div>
              <h2 className={styles.cardTitle}>What Mediant is hearing</h2>
              <p className={styles.cardSub}>Recurring themes from your recent sessions</p>
            </div>
          </header>

          {loading ? (
            <div className={styles.chipRow}>
              {[0, 1, 2, 3].map(i => <div key={i} className={styles.chipSkeleton} />)}
            </div>
          ) : hearing.length === 0 ? (
            <p className={styles.emptyLine}>
              Once you have a couple of analyzed sessions, recurring themes show up here.
            </p>
          ) : (
            <div className={styles.chipRow}>
              {hearing.map((h, i) => (
                <div key={h.type} className={styles.chip} style={{ '--d': `${260 + i * 60}ms` }}>
                  <div className={styles.chipTop}>
                    <span className={`${styles.chipIcon} ${styles[`type_${h.type}`] || styles.type_other} ${i === 0 ? styles.chipLead : ''}`}>
                      <TypeIcon type={h.type} />
                    </span>
                    <span className={styles.chipText}>
                      <span className={styles.chipName}>{TYPE_LABEL[h.type]}</span>
                      <span className={styles.chipDesc}>{h.example || 'Seen across recent takes'}</span>
                    </span>
                  </div>
                  <span className={`${styles.chipFreq} ${styles[`freq_${h.tone}`]}`}>{h.freq}</span>
                </div>
              ))}
            </div>
          )}

          <button className={styles.textLink} onClick={() => { playPop(); nav('/reports') }}>
            View all insights <ChevronIcon />
          </button>
        </article>

        <article className={`${styles.card} ${styles.recentCard}`} style={{ '--d': '280ms' }}>
          <header className={styles.cardHead}>
            <span className={styles.cardIcon}><WaveIcon /></span>
            <h2 className={styles.cardTitle}>Recent sessions</h2>
            <button className={styles.viewAll} onClick={() => { playPop(); nav('/sessions') }}>View all</button>
          </header>

          {loading ? (
            <div className={styles.recentList}>
              {[0, 1, 2, 3].map(i => <div key={i} className={styles.recentSkeleton} />)}
            </div>
          ) : recent.length === 0 ? (
            <div className={styles.emptyRecent}>
              <p className={styles.emptyLine}>No sessions yet.</p>
              <button className={styles.btnPrimarySm} onClick={() => { playPop(); setOpen(true) }}>
                Record your first
              </button>
            </div>
          ) : (
            <div className={styles.recentList}>
              {recent.map((t, i) => (
                <button key={t.id ?? i} className={styles.recentRow}
                        style={{ '--d': `${330 + i * 60}ms` }}
                        onClick={() => { playPop(); nav(t.id ? `/analysis?takeId=${t.id}` : '/sessions') }}>
                  <span className={styles.playBtn}><PlayIcon /></span>
                  <span className={styles.recentInfo}>
                    <span className={styles.recentTitle}>
                      {t.piece_title || 'Untitled'}
                      {t.piece_composer ? ` – ${t.piece_composer}` : ''}
                    </span>
                    <span className={styles.recentTime}>{timeLabel(t.created_at || t.date)}</span>
                  </span>
                  {t.score != null && (
                    <span className={`${styles.recentScore} ${
                      t.score >= 85 ? styles.scoreGood : t.score >= 70 ? styles.scoreOk : styles.scoreBad
                    }`}>{t.score}</span>
                  )}
                  <ChevronIcon />
                </button>
              ))}
            </div>
          )}
        </article>
      </section>
    </div>
  )
}

/* ══ Pieces ═══════════════════════════════════════════════════════════════ */

function Ring({ pct, label, shown, reduced }) {
  const R = 52, C = 2 * Math.PI * R
  const target = C * (1 - Math.min(100, Math.max(0, pct)) / 100)
  return (
    <div className={styles.ringWrap}>
      <svg viewBox="0 0 120 120" className={styles.ring}>
        <circle cx="60" cy="60" r={R} className={styles.ringTrack} />
        <circle cx="60" cy="60" r={R} className={styles.ringFill}
                style={{ strokeDasharray: C, strokeDashoffset: shown || reduced ? target : C }} />
      </svg>
      <div className={styles.ringCenter}>
        <span className={styles.ringValue}>{label}<span className={styles.ringPct}>%</span></span>
        <span className={styles.ringLabel}>This month</span>
      </div>
    </div>
  )
}

function Metric({ icon, tone, label, value, suffix, trailing, fill, delay }) {
  return (
    <div className={styles.metric} style={{ '--d': `${delay}ms` }}>
      <span className={`${styles.metricIcon} ${styles[`tone_${tone}`]}`}>{icon}</span>
      <div className={styles.metricBody}>
        <div className={styles.metricTop}>
          <span className={styles.metricLabel}>{label}</span>
          <span className={styles.metricValue}>
            {value}{suffix ? <span className={styles.metricValueSuffix}> {suffix}</span> : null}
          </span>
        </div>
        <div className={styles.metricBarRow}>
          <div className={styles.metricTrack}>
            <div className={styles.metricFill}
                 style={{ width: `${Math.max(0, Math.min(100, fill))}%`, transitionDelay: `${delay}ms` }} />
          </div>
          {trailing ? <span className={styles.metricTrail}>{trailing}</span> : null}
        </div>
      </div>
    </div>
  )
}

function Sparkline({ points, shown, reduced }) {
  const W = 250, H = 96, PAD = 8
  if (!points.length) return <div className={styles.sparkEmpty} aria-hidden="true" />
  const min = Math.min(...points), max = Math.max(...points)
  const span = max - min || 1
  const xs = points.map((_, i) => PAD + (i * (W - PAD * 2)) / Math.max(1, points.length - 1))
  const ys = points.map(p => H - PAD - ((p - min) / span) * (H - PAD * 2))
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  const LEN = W * 1.8
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.spark} aria-hidden="true">
      <path d={d} className={styles.sparkLine}
            style={{ strokeDasharray: LEN, strokeDashoffset: shown || reduced ? 0 : LEN }} />
      {xs.map((x, i) => (
        <circle key={i} cx={x} cy={ys[i]} r={i === xs.length - 1 ? 5 : 3.5}
                className={`${styles.sparkDot} ${i === xs.length - 1 ? styles.sparkDotLast : ''}`}
                style={{ opacity: shown || reduced ? 1 : 0,
                         transitionDelay: reduced ? '0ms' : `${500 + i * 60}ms` }} />
      ))}
    </svg>
  )
}

function Clipboard() {
  return (
    <svg viewBox="0 0 128 132" aria-hidden="true">
      <g stroke="#7FCBC8" strokeWidth="5" strokeLinecap="round">
        <path d="M6 34 L14 26" /><path d="M4 54 L15 54" /><path d="M8 74 L17 80" />
      </g>
      <rect x="28" y="14" width="94" height="112" rx="16" fill="#8C74C0" />
      <rect x="36" y="24" width="78" height="92" rx="10" fill="#FBF3E2" />
      <rect x="60" y="4" width="30" height="18" rx="8" fill="#A48FD4" />
      <circle cx="75" cy="9" r="5" fill="#8C74C0" />
      <path d="M58 44c3 4 9 4 12 0" fill="none" stroke="#3A3550" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M84 44c3 4 9 4 12 0" fill="none" stroke="#3A3550" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M68 56c5 5 13 5 18 0" fill="none" stroke="#3A3550" strokeWidth="3.4" strokeLinecap="round" />
      <ellipse cx="53" cy="52" rx="5" ry="3.2" fill="#F3A8A0" opacity="0.7" />
      <ellipse cx="101" cy="52" rx="5" ry="3.2" fill="#F3A8A0" opacity="0.7" />
      {[74, 92, 110].map((y, i) => (
        <g key={y}>
          <path d={`M46 ${y}l5 6 9-13`} fill="none"
                stroke={['#E2703F', '#6FA85C', '#E2703F'][i]}
                strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="66" y={y - 3} width={i === 1 ? 30 : 38} height="6" rx="3" fill="#EADFC9" />
        </g>
      ))}
    </svg>
  )
}

/* ══ Icons ════════════════════════════════════════════════════════════════ */
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }

function BarsIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="18" y1="20" x2="18" y2="14"/></svg>
}
function WaveIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><line x1="4" y1="10" x2="4" y2="14"/><line x1="8" y1="6" x2="8" y2="18"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="16" y1="7" x2="16" y2="17"/><line x1="20" y1="10" x2="20" y2="14"/></svg>
}
function CheckIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="9"/><polyline points="8.5 12 11 14.5 15.5 9.5"/></svg>
}
function StarIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}><polygon points="12 3 14.6 9.2 21 9.7 16 13.9 17.6 20.4 12 16.9 6.4 20.4 8 13.9 3 9.7 9.4 9.2"/></svg>
}
function TargetIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/></svg>
}
function EarIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><path d="M8 20a3 3 0 0 0 3-3c0-2 3-2.5 3-6a5 5 0 1 0-10 0"/><path d="M9 11a2.5 2.5 0 1 1 5 0"/></svg>
}
function ChevronIcon() {
  return <svg className={styles.chevron} width="16" height="16" viewBox="0 0 24 24" {...stroke}><polyline points="9 5 16 12 9 19"/></svg>
}
function PlayIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>
}
function ClipIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><rect x="5" y="4" width="14" height="17" rx="3"/><path d="M9 3h6v3H9z"/><polyline points="9 12 11 14 15 10"/></svg>
}
function TypeIcon({ type }) {
  if (type === 'rhythm' || type === 'timing')
    return <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>
  if (type === 'dynamics')
    return <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}><line x1="4" y1="11" x2="4" y2="13"/><line x1="9" y1="8" x2="9" y2="16"/><line x1="14" y1="5" x2="14" y2="19"/><line x1="19" y1="9" x2="19" y2="15"/></svg>
  if (type === 'articulation')
    return <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="6" r="1.8"/><path d="M12 8v5"/><path d="M12 13l-5 5"/><path d="M12 13l5 5"/></svg>
  return <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}><polyline points="22 12 18 12 15 20 9 4 6 12 2 12"/></svg>
}
