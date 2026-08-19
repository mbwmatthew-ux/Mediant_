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

  /* "Most improved": the issue type whose share of takes fell the most between
     the older half of the window and the recent half. Falls back to the score
     trend when there is not enough history to compare halves. */
  const improved = useMemo(() => {
    const withFlags = sessions.filter(t => Array.isArray(t.flags))
    const delta = scoreTrend.length >= 2
      ? Math.round(scoreTrend[scoreTrend.length - 1] - scoreTrend[0]) : null
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
  }, [sessions, scoreTrend])

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
                value={`${Math.round(countValue)} / ${MONTHLY_GOAL}`}
                fill={shown ? Math.min(100, (monthCount / MONTHLY_GOAL) * 100) : 0}
                delay={260}
              />
              <Metric
                icon={<StarIcon />} tone="gold" label="Average score"
                value={avgScore != null ? `${Math.round(scoreValue)} / 100` : '—'}
                fill={shown && avgScore != null ? avgScore : 0}
                delay={340}
              />
              <Metric
                icon={<TargetIcon />} tone="coral" label="Streak"
                value={`${streak} ${streak === 1 ? 'day' : 'days'}`}
                suffix={streak >= 3 ? '🔥' : null}
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
            <span className={styles.improvedDelta}>
              +{improved.delta} points over your last {scoreTrend.length} sessions
            </span>
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
            <span className={styles.cardIcon}><EarIcon /></span>
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
                  <span className={`${styles.chipIcon} ${styles[`type_${h.type}`] || styles.type_other}`}>
                    <TypeIcon type={h.type} />
                  </span>
                  <span className={styles.chipName}>{TYPE_LABEL[h.type]}</span>
                  <span className={styles.chipDesc}>{h.example || 'Seen across recent takes'}</span>
                  <span className={`${styles.chipFreq} ${styles[`freq_${h.tone}`]}`}>{h.freq}</span>
                </div>
              ))}
            </div>
          )}

          <button className={styles.textLink} onClick={() => { playPop(); nav('/reports') }}>
            View all insights <ArrowIcon />
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

function Metric({ icon, tone, label, value, fill, suffix, delay }) {
  return (
    <div className={styles.metric} style={{ '--d': `${delay}ms` }}>
      <span className={`${styles.metricIcon} ${styles[`tone_${tone}`]}`}>{icon}</span>
      <div className={styles.metricBody}>
        <div className={styles.metricTop}>
          <span className={styles.metricLabel}>{label}</span>
          <span className={styles.metricValue}>
            {value}{suffix ? <span className={styles.metricSuffix}>{suffix}</span> : null}
          </span>
        </div>
        <div className={styles.metricTrack}>
          <div
            className={`${styles.metricFill} ${styles[`fill_${tone}`]}`}
            style={{ width: `${Math.max(0, Math.min(100, fill))}%`, transitionDelay: `${delay}ms` }}
          />
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
    <svg className={styles.blob} viewBox="0 0 620 400" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="mdBlob" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stopColor="#8FC5A8" />
          <stop offset="55%"  stopColor="#6FB295" />
          <stop offset="100%" stopColor="#57A184" />
        </linearGradient>
      </defs>
      {/* Asymmetric on purpose: a plain ellipse reads as a stock shape, and the
          first pass looked exactly like one. The dip on the lower left is what
          makes it feel hand-drawn. */}
      <path fill="url(#mdBlob)" d="M118 44C186 6 292-6 380 10c94 17 168 60 202 124 34 65 22 145-28 196-48 49-132 74-214 68-70-5-126-33-170-72-22-20-52-30-78-52-30-25-52-58-56-98-5-52 22-96 82-132Z" />
    </svg>
  )
}

/** The Mediant character: a soft blob wearing headphones, eyes closed, happy. */
function Mascot() {
  return (
    <svg viewBox="0 0 200 190" className={styles.mascot} role="img" aria-label="Mediant mascot listening with headphones">
      <defs>
        <linearGradient id="mdBody" x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%"   stopColor="#C9E7D6" />
          <stop offset="100%" stopColor="#9CD0B6" />
        </linearGradient>
      </defs>
      {/* body */}
      <path fill="url(#mdBody)" d="M100 24c34 0 58 22 62 52 4 30-6 60-24 74-18 14-58 16-80 4S30 112 32 84C34 56 66 24 100 24Z" />
      {/* headphone band + cups */}
      <path className={styles.mascotBand} d="M38 78a62 62 0 0 1 124 0" />
      <rect className={styles.mascotCup} x="24" y="72" width="24" height="38" rx="12" />
      <rect className={styles.mascotCup} x="152" y="72" width="24" height="38" rx="12" />
      {/* closed, content eyes */}
      <path className={styles.mascotFace} d="M74 106c4 5 12 5 16 0" />
      <path className={styles.mascotFace} d="M110 106c4 5 12 5 16 0" />
      {/* smile */}
      <path className={styles.mascotFace} d="M88 124c6 7 18 7 24 0" />
      {/* cheeks */}
      <ellipse cx="70" cy="120" rx="7" ry="4.5" fill="#F2A9A0" opacity="0.55" />
      <ellipse cx="130" cy="120" rx="7" ry="4.5" fill="#F2A9A0" opacity="0.55" />
      {/* thumbs up */}
      <path fill="#8FC9AC" stroke="#4E9375" strokeWidth="3" strokeLinejoin="round"
            d="M132 146c0-6 6-8 8-14 1-4 0-9 4-9s6 5 5 11l-1 6h12c4 0 6 3 5 7l-4 16c-1 4-4 6-8 6h-16c-3 0-5-2-5-5Z" />
    </svg>
  )
}

function Clipboard() {
  return (
    <svg viewBox="0 0 92 106" aria-hidden="true">
      <rect x="6" y="12" width="80" height="88" rx="10" fill="#fff" stroke="#B9A9E0" strokeWidth="3" />
      <rect x="30" y="2" width="32" height="18" rx="7" fill="#C9BCEC" stroke="#9E8BD4" strokeWidth="3" />
      {[34, 52, 70].map((y, i) => (
        <g key={y}>
          <path d={`M20 ${y}l6 6 10-12`} fill="none" stroke="#7FB89A" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="44" y={y - 4} width={i === 1 ? 26 : 32} height="6" rx="3" fill="#E6DFF6" />
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
