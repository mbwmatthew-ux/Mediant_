import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTakes } from '../hooks/useTakes'
import { useAuth } from '../context/AuthContext'
import { useRecordModal } from '../context/RecordModalContext'
import { usePrefersReducedMotion, useMounted, useCountUp } from '../hooks/useMotion'
import styles from './Home.module.css'
import { playPop } from '../utils/sounds'

/* ── Goal for the monthly ring. Kept here so the ring, the "18 / 25" row and
      the percentage can never disagree — they all read this one number. ── */
const MONTHLY_GOAL = 25

const TYPE_LABEL = {
  intonation: 'Intonation', rhythm: 'Rhythm', timing: 'Timing',
  dynamics: 'Dynamics', articulation: 'Articulation', tone: 'Tone',
  phrasing: 'Phrasing', posture: 'Posture', technique: 'Technique',
  error: 'Wrong notes', voicing: 'Voicing',
}

/* Suggestion shown in "Up next", chosen from the issue seen most often. */
const FOCUS_BY_TYPE = {
  intonation:   { name: 'Long-tone tuning',   hint: 'Steady pitch against a drone' },
  rhythm:       { name: 'Subdivided metronome', hint: 'Lock the inner pulse' },
  timing:       { name: 'Metronome anchoring', hint: 'Hold one tempo end to end' },
  dynamics:     { name: 'Terraced dynamics',  hint: 'Widen your soft-to-loud range' },
  articulation: { name: 'Detached attacks',   hint: 'Cleaner starts to each note' },
  tone:         { name: 'Sustained tone',     hint: 'Even colour through the phrase' },
  phrasing:     { name: 'Smooth legato',      hint: 'Improve connection between notes' },
  technique:    { name: 'Slow-tempo drilling', hint: 'Build accuracy before speed' },
  posture:      { name: 'Setup and balance',  hint: 'Release tension while you play' },
  error:        { name: 'Note accuracy',      hint: 'Slow passes with the score open' },
}
const DEFAULT_FOCUS = { name: 'Smooth legato', hint: 'Improve connection between notes' }

function timeLabel(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const day = new Date(d); day.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diff = Math.round((today - day) / 86400000)
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (diff === 0) return `Today · ${clock}`
  if (diff === 1) return `Yesterday · ${clock}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${clock}`
}

function calcStreak(sessions) {
  if (!sessions.length) return 0
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const dateSet = new Set(sessions.map(s => {
    const d = new Date(s.created_at || s.date || '')
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }).filter(n => !Number.isNaN(n)))
  const check = new Date(today)
  if (!dateSet.has(check.getTime())) check.setDate(check.getDate() - 1)
  let streak = 0
  while (dateSet.has(check.getTime())) { streak++; check.setDate(check.getDate() - 1) }
  return streak
}

export default function Home() {
  const nav = useNavigate()
  const { user } = useAuth()
  const { setOpen } = useRecordModal()
  const takes = useTakes({ limit: 60 })
  const loading = takes === undefined
  const sessions = useMemo(() => takes ?? [], [takes])
  const reduced = usePrefersReducedMotion()
  const shown = useMounted()

  const firstName = (user?.name || '').trim().split(/\s+/)[0]

  /* ── Derived stats ─────────────────────────────────────────────────────── */
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

  /* Scores oldest→newest, for the sparkline. */
  const scoreTrend = useMemo(() => {
    const s = sessions.filter(t => t.score != null).slice(0, 8).map(t => t.score).reverse()
    return s.length >= 2 ? s : []
  }, [sessions])

  /* Scored takes inside the current calendar month, oldest→newest. Kept
     separate from scoreTrend so the card can say "this month" and have it be
     true — the sparkline window is the last 8 takes regardless of date. */
  const monthTrend = useMemo(() => {
    const now = new Date()
    const s = sessions
      .filter(t => {
        if (t.score == null) return false
        const d = new Date(t.created_at || t.date || '')
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      })
      .map(t => t.score).reverse()
    return s.length >= 2 ? s : []
  }, [sessions])

  /* "Most improved": the issue type whose share of takes fell the most between
     the older half of the window and the recent half. Falls back to the score
     trend when there is not enough history to compare halves. */
  const improved = useMemo(() => {
    const withFlags = sessions.filter(t => Array.isArray(t.flags))
    const delta = monthTrend.length >= 2
      ? Math.round(monthTrend[monthTrend.length - 1] - monthTrend[0]) : null
    if (withFlags.length < 4) return { label: null, delta }

    const half = Math.floor(withFlags.length / 2)
    const recent = withFlags.slice(0, half)        // sessions are newest-first
    const older  = withFlags.slice(half)
    const share = (group, type) =>
      group.filter(t => t.flags.some(f => (f.type ?? '').toLowerCase() === type)).length / (group.length || 1)

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

  /* What Mediant keeps hearing — top issue types with an honest frequency word. */
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
    return Object.values(counts)
      .map(c => {
        const pct = c.takes / withFlags.length
        return {
          ...c,
          freq: pct >= 0.6 ? 'Appears often' : pct >= 0.3 ? 'Sometimes' : 'Rarely',
          tone: pct >= 0.6 ? 'high' : pct >= 0.3 ? 'mid' : 'low',
        }
      })
      .sort((a, b) => b.takes - a.takes)
      .slice(0, 4)
  }, [sessions])

  const focus = useMemo(() => {
    const top = hearing[0]
    return (top && FOCUS_BY_TYPE[top.type]) || DEFAULT_FOCUS
  }, [hearing])

  const recent = sessions.slice(0, 3)
  const lastTakeId = sessions[0]?.id
  const hasHistory = sessions.length > 0

  /* ── Animated values ───────────────────────────────────────────────────── */
  const ringValue  = useCountUp(shown ? ringPct : 0, { reduced, duration: 1200 })
  const countValue = useCountUp(shown ? monthCount : 0, { reduced, duration: 900 })
  const scoreValue = useCountUp(shown && avgScore != null ? avgScore : 0, { reduced, duration: 1000 })

  const openRecorder = () => { playPop(); setOpen(true) }

  return (
    <div className={`${styles.page} ${reduced ? styles.noMotion : ''}`}>

      {/* Decorative layer. Purely atmospheric, aria-hidden, pointer-events
          none — it must never intercept a click or be read aloud. */}
      <div className={styles.decor} aria-hidden="true">
        <span className={styles.decorPeach} />
        <span className={styles.decorDots} />
        <span className={styles.decorTicks}>
          <svg viewBox="0 0 34 30" fill="none" stroke="#7FB89A" strokeWidth="3" strokeLinecap="round">
            <path d="M4 20 L10 12" /><path d="M14 25 L18 15" /><path d="M2 29 L6 26" />
          </svg>
        </span>
      </div>

      {/* ══ HERO ══════════════════════════════════════════════════════════ */}
      <section className={styles.hero}>
        <div className={styles.heroLeft} style={{ '--d': '0ms' }}>
          <p className={styles.greeting}>
            {firstName ? `Good to see you, ${firstName}!` : 'Good to see you!'}
            <span className={styles.wave} aria-hidden="true">👋</span>
          </p>

          <h1 className={styles.heroTitle}>
            Let’s level up<br />your <span className={styles.underlined}>
              music.
              <Squiggle />
            </span>
          </h1>

          <p className={styles.heroSub}>
            Record a session, get bar-by-bar feedback,<br />and watch your playing grow.
          </p>

          <div className={styles.heroActions}>
            <button className={styles.btnPrimary} onClick={openRecorder}>
              <MicIcon />
              Start a new session
              <span className={styles.btnGlow} aria-hidden="true" />
            </button>
            <button
              className={styles.btnGhost}
              onClick={() => { playPop(); lastTakeId ? nav(`/analysis?takeId=${lastTakeId}`) : setOpen(true) }}
            >
              <UploadIcon />
              {lastTakeId ? 'View last analysis' : 'Upload audio or MIDI'}
            </button>
          </div>
        </div>

        <div className={styles.heroRight} style={{ '--d': '90ms' }}>
          <Blob />
          <span className={styles.blobSun} aria-hidden="true" />
          <span className={styles.blobMint} aria-hidden="true" />
          <span className={`${styles.note} ${styles.noteGreen}`} aria-hidden="true"><NoteIcon /></span>
          <span className={`${styles.note} ${styles.noteGreen2}`} aria-hidden="true"><NoteIcon /></span>
          <span className={`${styles.note} ${styles.noteCoral}`} aria-hidden="true"><NoteIcon /></span>
          <span className={`${styles.sparkle} ${styles.sparkleA}`} aria-hidden="true"><SparkleIcon /></span>
          <span className={`${styles.sparkle} ${styles.sparkleB}`} aria-hidden="true"><SparkleIcon /></span>
          <div className={styles.mascotWrap}>
            <Mascot />
          </div>
          <div className={styles.helpPanel}>
            <h2 className={styles.helpTitle}>How Mediant helps</h2>
            {[
              { icon: <WaveIcon />,  t: 'You play',            d: 'Record your performance or upload a file.' },
              { icon: <SparkIcon />, t: 'AI listens closely',  d: 'Mediant analyzes pitch, rhythm, dynamics, and articulation.' },
              { icon: <ChatIcon />,  t: 'Get bar-by-bar feedback', d: 'Understand what to refine and how to improve.' },
            ].map((s, i) => (
              <div key={s.t} className={styles.helpStep} style={{ '--d': `${220 + i * 90}ms` }}>
                <span className={styles.helpIcon}>{s.icon}</span>
                <div>
                  <span className={styles.helpStepTitle}>{s.t}</span>
                  <p className={styles.helpStepDesc}>{s.d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ CARD GRID ═════════════════════════════════════════════════════ */}
      <section className={styles.grid}>

        {/* ── Your progress ── */}
        <article className={`${styles.card} ${styles.progressCard}`} style={{ '--d': '180ms' }}>
          <header className={styles.cardHead}>
            <span className={styles.cardIcon}><ChartIcon /></span>
            <h2 className={styles.cardTitle}>Your progress</h2>
          </header>

          <div className={styles.progressBody}>
            <Ring pct={ringValue} label={Math.round(ringValue)} shown={shown} reduced={reduced} />

            <div className={styles.metrics}>
              <Metric
                icon={<CheckIcon />} tone="green" label="Sessions recorded"
                value={Math.round(countValue)} suffix={`/ ${MONTHLY_GOAL}`}
                fill={shown ? Math.min(100, (monthCount / MONTHLY_GOAL) * 100) : 0}
                delay={260}
              />
              <Metric
                icon={<StarIcon />} tone="gold" label="Average score"
                value={avgScore != null ? Math.round(scoreValue) : '—'}
                suffix={avgScore != null ? '/ 100' : null}
                fill={shown && avgScore != null ? avgScore : 0}
                delay={340}
              />
              <Metric
                icon={<TargetIcon />} tone="lav" label="Streak"
                value={streak} suffix={streak === 1 ? 'day' : 'days'}
                trailing={streak >= 3 ? '🔥' : null}
                fill={shown ? Math.min(100, (streak / 7) * 100) : 0}
                delay={420}
              />
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

        {/* ── Most improved ── */}
        <article className={`${styles.card} ${styles.improvedCard}`} style={{ '--d': '250ms' }}>
          <span className={styles.improvedEyebrow}>{hasHistory ? 'MOST IMPROVED' : 'FIRST STEPS'}</span>
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
                View detailed progress
                <ArrowIcon />
              </button>
              <span className={styles.trophy} aria-hidden="true">🏆</span>
            </>
          )}
        </article>

        {/* ── Up next ── */}
        <article className={`${styles.card} ${styles.nextCard}`} style={{ '--d': '320ms' }}>
          <span className={styles.nextEyebrow}>UP NEXT</span>
          <h2 className={styles.nextTitle}>Try a focused session</h2>
          <p className={styles.nextSub}>Pick a goal and record 5–10 minutes.</p>

          <button className={styles.focusRow} onClick={openRecorder}>
            <span className={styles.focusIcon}><ClipIcon /></span>
            <span className={styles.focusText}>
              <span className={styles.focusName}>{focus.name}</span>
              <span className={styles.focusHint}>{focus.hint}</span>
            </span>
            <ChevronIcon />
          </button>

          <span className={styles.clipboard} aria-hidden="true"><Clipboard /></span>
        </article>

        {/* ── What Mediant is hearing ── */}
        <article className={`${styles.card} ${styles.hearingCard}`} style={{ '--d': '390ms' }}>
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
                <div key={h.type} className={styles.chip} style={{ '--d': `${460 + i * 70}ms` }}>
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

        {/* ── Recent sessions ── */}
        <article className={`${styles.card} ${styles.recentCard}`} style={{ '--d': '460ms' }}>
          <header className={styles.cardHead}>
            <span className={styles.cardIcon}><WaveIcon /></span>
            <h2 className={styles.cardTitle}>Recent sessions</h2>
            <button className={styles.viewAll} onClick={() => { playPop(); nav('/sessions') }}>View all</button>
          </header>

          {loading ? (
            <div className={styles.recentList}>
              {[0, 1, 2].map(i => <div key={i} className={styles.recentSkeleton} />)}
            </div>
          ) : recent.length === 0 ? (
            <div className={styles.emptyRecent}>
              <p className={styles.emptyLine}>No sessions yet.</p>
              <button className={styles.btnPrimarySm} onClick={openRecorder}>
                <MicIcon /> Record your first
              </button>
            </div>
          ) : (
            <div className={styles.recentList}>
              {recent.map((t, i) => (
                <button
                  key={t.id ?? i}
                  className={styles.recentRow}
                  style={{ '--d': `${520 + i * 70}ms` }}
                  onClick={() => { playPop(); nav(t.id ? `/analysis?takeId=${t.id}` : '/sessions') }}
                >
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

/** Donut. The dash offset transitions, so the arc sweeps rather than snapping. */
function Ring({ pct, label, shown, reduced }) {
  const R = 52, C = 2 * Math.PI * R
  const target = C * (1 - Math.min(100, Math.max(0, pct)) / 100)
  return (
    <div className={styles.ringWrap}>
      <svg viewBox="0 0 120 120" className={styles.ring}>
        <circle cx="60" cy="60" r={R} className={styles.ringTrack} />
        <circle
          cx="60" cy="60" r={R} className={styles.ringFill}
          style={{
            strokeDasharray: C,
            strokeDashoffset: shown || reduced ? target : C,
          }}
        />
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
            <div
              className={styles.metricFill}
              style={{ width: `${Math.max(0, Math.min(100, fill))}%`, transitionDelay: `${delay}ms` }}
            />
          </div>
          {trailing ? <span className={styles.metricTrail}>{trailing}</span> : null}
        </div>
      </div>
    </div>
  )
}

/** Score trend. The path draws itself in, then the dots pop along it. */
function Sparkline({ points, shown, reduced }) {
  const W = 240, H = 62, PAD = 6
  if (!points.length) {
    return <div className={styles.sparkEmpty} aria-hidden="true" />
  }
  const min = Math.min(...points), max = Math.max(...points)
  const span = max - min || 1
  const xs = points.map((_, i) => PAD + (i * (W - PAD * 2)) / Math.max(1, points.length - 1))
  const ys = points.map(p => H - PAD - ((p - min) / span) * (H - PAD * 2))
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  // Rough path length; only needs to exceed the true length for the draw-in.
  const LEN = W * 1.6

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.spark} aria-hidden="true">
      <path
        d={d} className={styles.sparkLine}
        style={{
          strokeDasharray: LEN,
          strokeDashoffset: shown || reduced ? 0 : LEN,
        }}
      />
      {xs.map((x, i) => (
        <circle
          key={i} cx={x} cy={ys[i]} r={i === xs.length - 1 ? 4.5 : 3}
          className={`${styles.sparkDot} ${i === xs.length - 1 ? styles.sparkDotLast : ''}`}
          style={{
            opacity: shown || reduced ? 1 : 0,
            transitionDelay: reduced ? '0ms' : `${600 + i * 70}ms`,
          }}
        />
      ))}
    </svg>
  )
}

/* ══ Art ══════════════════════════════════════════════════════════════════ */

/** Hand-drawn underline. Draws itself after the headline lands. */
function Squiggle() {
  return (
    <svg className={styles.squiggle} viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true">
      <path d="M2 8c14-5 28-5 42 0s28 5 42 0 28-5 42 0 28 5 42 0 26-4 28-2" />
    </svg>
  )
}

/** Organic backdrop for the hero panel. */
function Blob() {
  return (
    <svg className={styles.blob} viewBox="0 0 620 347" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="mdBlob" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#93BFAC" />
          <stop offset="55%"  stopColor="#85B5A5" />
          <stop offset="100%" stopColor="#6FAA98" />
        </linearGradient>
      </defs>
      {/* Traced from agent_workspace/reference/home-redesign-2026-08.jpeg with
          agent_workspace/trace_asset.py. Hand-drawing this produced an ellipse
          and missed the deep concave sweep along the bottom-left, which is the
          shape's whole character. Traced with heavy morphological closing —
          a lighter pass let a sparkle break the silhouette and the walk traced
          a visible spike through the notch. */}
      <path fill="url(#mdBlob)" d="M360.6,19.6 C380.6,18.6 448.1,31.7 461.7,38.3 C475.4,44.9 516.9,85.7 524.6,98.7 C532.2,111.8 551.0,181.8 553.1,195.0 C555.2,208.2 552.1,247.5 549.8,257.0 C547.6,266.4 531.2,302.2 526.2,308.4 C521.2,314.6 496.5,328.9 489.5,331.2 C482.5,333.5 463.0,339.8 442.2,336.1 C421.3,332.4 264.5,288.7 239.0,286.3 C213.5,284.0 147.2,306.4 136.2,307.6 C125.3,308.7 111.7,303.5 107.7,300.2 C103.7,296.9 90.0,277.4 88.1,267.6 C86.2,257.8 85.9,190.8 84.8,182.7 C84.0,173.8 87.6,167.4 91.4,163.2 C95.0,158.3 108.3,122.8 119.1,113.4 C129.9,103.9 201.0,57.6 221.1,49.8 C241.2,41.9 340.5,20.5 360.6,19.6 Z" />
    </svg>
  )
}

/**
 * The Mediant character.
 *
 * Built with the `image-to-svg` skill's workflow against
 * agent_workspace/reference/home-redesign-2026-08.jpeg: crop at 4x, posterise,
 * auto-trace with vtracer to read the real construction, then rebuild each
 * feature and iterate with a render-compare loop (rsvg-convert + ImageMagick
 * RMSE). Converged at RMSE 0.096 against the reference, from 0.41 for the
 * earlier hand-drawn version.
 *
 * The measurement fix that mattered: the first diffs compared a cut-out mascot
 * against a flat background and the score would not move, because it was
 * measuring the background rather than the character. Compositing this render
 * onto the reference's OWN backdrop and diffing against the untouched original
 * made the metric mean something.
 */
function Mascot() {
  return (
    <svg viewBox="0 -50 512 510" className={styles.mascot} role="img"
         aria-label="Mediant mascot listening with headphones">
      <defs>
        <radialGradient id="mdBody" cx="45%" cy="20%" r="88%">
          <stop offset="0%"   stopColor="#95DABA" />
          <stop offset="52%"  stopColor="#6FC2A2" />
          <stop offset="100%" stopColor="#4C9C84" />
        </radialGradient>
      </defs>

      {/* headphone band, behind the head */}
      <path d="M132 150 C144 -46 380 -46 396 152" fill="none"
            stroke="#17453F" strokeWidth="14" strokeLinecap="round" />
      {/* right arm crescent */}
      <path d="M352 204 C420 232 422 280 382 306" fill="none"
            stroke="#17453F" strokeWidth="30" strokeLinecap="round" />

      {/* body: rounded crown, broad base */}
      <path fill="url(#mdBody)"
            d="M253 14 C318 14 352 60 356 122 C360 176 388 234 393 290
               C398 348 340 396 253 396 C166 396 108 348 113 290
               C118 234 146 176 150 122 C154 60 188 14 253 14 Z" />

      {/* left arm: thumbs-up */}
      <path fill="#17453F"
            d="M30 258 C30 246 44 243 49 231 C53 221 50 211 60 210
               C71 209 74 221 72 235 l-2 13 h28 c11 0 16 9 14 18
               l-10 40 c-2 9 -9 14 -19 14 H33 c-10 0 -17 -5 -17 -14 Z" />

      {/* ear cups: a pale pad inside a dark shell, angled outward */}
      <g transform="rotate(-20 142 112)">
        <rect x="112" y="56" width="62" height="112" rx="31" fill="#17453F" />
        <rect x="122" y="66" width="34" height="92"  rx="17" fill="#4E9182" />
      </g>
      <g transform="rotate(18 368 126)">
        <rect x="336" y="64" width="66" height="120" rx="33" fill="#17453F" />
        <rect x="352" y="75" width="36" height="98"  rx="18" fill="#4E9182" />
      </g>

      <ellipse cx="180" cy="136" rx="22" ry="13" fill="#EE9A92" opacity="0.45" />
      <ellipse cx="304" cy="142" rx="22" ry="13" fill="#EE9A92" opacity="0.45" />

      {/* closed, content eyes */}
      <path d="M192 120 C202 104 221 104 231 120" fill="none"
            stroke="#17453F" strokeWidth="11" strokeLinecap="round" />
      <path d="M275 125 C285 109 304 109 314 125" fill="none"
            stroke="#17453F" strokeWidth="11" strokeLinecap="round" />

      {/* open mouth with a tongue */}
      <path d="M228 136 H278 A25 25 0 0 1 228 136 Z" fill="#17453F" />
      <path d="M240 156 A13 13 0 0 1 266 156 Z" fill="#E24B45" />
    </svg>
  )
}

function Clipboard() {
  return (
    <svg viewBox="0 0 128 132" aria-hidden="true">
      {/* Motion ticks on the left, as in the reference. */}
      <g stroke="#7FCBC8" strokeWidth="5" strokeLinecap="round">
        <path d="M6 34 L14 26" /><path d="M4 54 L15 54" /><path d="M8 74 L17 80" />
      </g>
      {/* Board */}
      <rect x="28" y="14" width="94" height="112" rx="16" fill="#8C74C0" />
      <rect x="36" y="24" width="78" height="92" rx="10" fill="#FBF3E2" />
      {/* Clip */}
      <rect x="60" y="4" width="30" height="18" rx="8" fill="#A48FD4" />
      <circle cx="75" cy="9" r="5" fill="#8C74C0" />
      {/* Face — the board is a character in the reference, not a plain icon. */}
      <path d="M58 44c3 4 9 4 12 0" fill="none" stroke="#3A3550" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M84 44c3 4 9 4 12 0" fill="none" stroke="#3A3550" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M68 56c5 5 13 5 18 0" fill="none" stroke="#3A3550" strokeWidth="3.4" strokeLinecap="round" />
      <ellipse cx="53" cy="52" rx="5" ry="3.2" fill="#F3A8A0" opacity="0.7" />
      <ellipse cx="101" cy="52" rx="5" ry="3.2" fill="#F3A8A0" opacity="0.7" />
      {/* Checklist */}
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

function MicIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
}
function UploadIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
}
function WaveIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><line x1="4" y1="10" x2="4" y2="14"/><line x1="8" y1="6" x2="8" y2="18"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="16" y1="7" x2="16" y2="17"/><line x1="20" y1="10" x2="20" y2="14"/></svg>
}
function SparkIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/></svg>
}
function ChatIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>
}
function ChartIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="18" y1="20" x2="18" y2="14"/></svg>
}
function CheckIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="9"/><polyline points="8.5 12 11 14.5 15.5 9.5"/></svg>
}
function StarIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><polygon points="12 3 14.6 9.2 21 9.7 16 13.9 17.6 20.4 12 16.9 6.4 20.4 8 13.9 3 9.7 9.4 9.2"/></svg>
}
function TargetIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/></svg>
}
function EarIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><path d="M8 20a3 3 0 0 0 3-3c0-2 3-2.5 3-6a5 5 0 1 0-10 0"/><path d="M9 11a2.5 2.5 0 1 1 5 0"/></svg>
}
function ArrowIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}><line x1="5" y1="12" x2="18" y2="12"/><polyline points="12 6 18 12 12 18"/></svg>
}
function ChevronIcon() {
  return <svg className={styles.chevron} width="15" height="15" viewBox="0 0 24 24" {...stroke}><polyline points="9 5 16 12 9 19"/></svg>
}
function PlayIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>
}
function ClipIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><rect x="5" y="4" width="14" height="17" rx="3"/><path d="M9 3h6v3H9z"/><polyline points="9 12 11 14 15 10"/></svg>
}
function NoteIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 18.5A3.5 3.5 0 1 1 12 15.3V5.6l8-1.6v8.9a3.5 3.5 0 1 1-2-3.2V6.4l-4 .8v11.3Z"/></svg>
}
function SparkleIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.6 4.6 2.6 6.6 7.2 7.2-4.6.6-6.6 2.6-7.2 7.2-.6-4.6-2.6-6.6-7.2-7.2C9.4 8.6 11.4 6.6 12 2Z"/></svg>
}
function TypeIcon({ type }) {
  if (type === 'rhythm' || type === 'timing')
    return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>
  if (type === 'dynamics')
    return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><line x1="4" y1="12" x2="4" y2="12"/><line x1="9" y1="9" x2="9" y2="15"/><line x1="14" y1="6" x2="14" y2="18"/><line x1="19" y1="3" x2="19" y2="21"/></svg>
  if (type === 'articulation')
    return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/><path d="M4 17c5 3 11 3 16 0"/></svg>
  return <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}><polyline points="22 12 18 12 15 20 9 4 6 12 2 12"/></svg>
}
