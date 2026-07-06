import { useEffect, useRef, useState } from 'react'
import { getAudioContext, unlockAudio } from '../utils/sounds'
import styles from './FixThisSection.module.css'

const BPM_MIN = 40
const BPM_MAX = 240
const SCHEDULE_AHEAD = 0.12
const TICK_MS = 25
const SPEEDS = [0.5, 0.75, 1]

// Cluster flags by measure proximity, score by count + low confidence, return worst cluster.
function findWorstSection(flags) {
  if (!flags?.length) return null
  const sorted = [...flags].sort((a, b) => (a.measure ?? 0) - (b.measure ?? 0))

  const groups = []
  let cur = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = cur[cur.length - 1]
    const gap = (sorted[i].measure ?? 0) - (prev.measure_end ?? prev.measure ?? 0)
    if (gap <= 4) cur.push(sorted[i])
    else { groups.push(cur); cur = [sorted[i]] }
  }
  groups.push(cur)

  const best = groups
    .map(grp => ({
      flags: grp,
      score: grp.length * 15 + grp.reduce((s, f) => s + (100 - (f.confidence ?? 80)), 0),
    }))
    .sort((a, b) => b.score - a.score)[0]

  const measureStart = Math.min(...best.flags.map(f => f.measure ?? 0))
  const measureEnd   = Math.max(...best.flags.map(f => f.measure_end ?? f.measure ?? 0))

  const withTs = best.flags.filter(f => f.timestamp_start != null && f.timestamp_end != null)
  const timestampStart = withTs.length ? Math.min(...withTs.map(f => Number(f.timestamp_start))) : null
  const timestampEnd   = withTs.length ? Math.max(...withTs.map(f => Number(f.timestamp_end)))   : null

  const typeCounts = {}
  best.flags.forEach(f => {
    const t = (f.type ?? '').toLowerCase()
    typeCounts[t] = (typeCounts[t] ?? 0) + 1
  })
  const types = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t[0].toUpperCase() + t.slice(1))

  return { flags: best.flags, measureStart, measureEnd, timestampStart, timestampEnd, types, flagCount: best.flags.length }
}

export default function FixThisSection({
  flags, isLooping, loopRef, onStartLoop, onStopLoop,
  videoSpeed, onSpeedChange, onReRecord, onSeek,
}) {
  const [dismissed,    setDismissed]    = useState(false)
  const [bpm,          setBpm]          = useState(80)
  const [metroPlaying, setMetroPlaying] = useState(false)
  const [beat,         setBeat]         = useState(-1)
  const [tapTimes,     setTapTimes]     = useState([])

  const schedulerRef  = useRef(null)
  const nextBeatRef   = useRef(0)
  const beatIdxRef    = useRef(0)
  const bpmRef        = useRef(bpm)

  useEffect(() => { bpmRef.current = bpm }, [bpm])

  // Stop metronome on unmount
  useEffect(() => () => clearTimeout(schedulerRef.current), [])

  function playClick(time, accent) {
    try {
      const ctx  = getAudioContext()
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = accent ? 1760 : 1100
      gain.gain.setValueAtTime(accent ? 0.9 : 0.55, time)
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04)
      osc.start(time); osc.stop(time + 0.04)
    } catch {}
  }

  function schedule() {
    try {
      const ctx = getAudioContext()
      while (nextBeatRef.current < ctx.currentTime + SCHEDULE_AHEAD) {
        const accent = beatIdxRef.current === 0
        playClick(nextBeatRef.current, accent)
        const delay = Math.max(0, (nextBeatRef.current - ctx.currentTime) * 1000)
        const captured = beatIdxRef.current
        setTimeout(() => setBeat(captured), delay)
        nextBeatRef.current += 60 / bpmRef.current
        beatIdxRef.current = (beatIdxRef.current + 1) % 4
      }
    } catch {}
    schedulerRef.current = setTimeout(schedule, TICK_MS)
  }

  useEffect(() => {
    if (!metroPlaying) {
      clearTimeout(schedulerRef.current)
      setBeat(-1)
      return
    }
    const ctx = getAudioContext()
    if (ctx.state === 'suspended') ctx.resume()
    nextBeatRef.current = ctx.currentTime + 0.05
    beatIdxRef.current  = 0
    schedulerRef.current = setTimeout(schedule, 0)
    return () => clearTimeout(schedulerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metroPlaying])

  const section = findWorstSection(flags)
  if (dismissed || !section) return null

  const hasTs = section.timestampStart != null && section.timestampEnd != null
  const isSectionLooping = isLooping && hasTs &&
    Math.abs((loopRef?.current?.start ?? -1) - section.timestampStart) < 0.01

  const measureLabel = section.measureStart === section.measureEnd
    ? `Measure ${section.measureStart}`
    : `Measures ${section.measureStart}–${section.measureEnd}`

  const typeLabel = section.types.slice(0, 3).join(' · ')

  function handleLoop() {
    if (!hasTs) return
    isSectionLooping
      ? onStopLoop()
      : onStartLoop({ timestamp_start: section.timestampStart, timestamp_end: section.timestampEnd })
  }

  function handleReplay() {
    if (hasTs) onSeek(section.timestampStart)
  }

  async function toggleMetro() {
    try { await unlockAudio() } catch {}
    setMetroPlaying(p => !p)
  }

  function handleTap() {
    const now = Date.now()
    setTapTimes(prev => {
      const next = [...prev, now].slice(-6)
      if (next.length >= 2) {
        const intervals = next.slice(1).map((t, i) => t - next[i])
        const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length
        const computed = Math.round(60000 / avg)
        if (computed >= BPM_MIN && computed <= BPM_MAX) setBpm(computed)
      }
      return next
    })
  }

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.eyebrow}>Fix This Section</span>
        <button className={styles.dismissBtn} onClick={() => setDismissed(true)} aria-label="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div className={styles.body}>
        {/* Problem statement */}
        <div className={styles.problem}>
          <p className={styles.headline}>
            Your biggest issue is <strong>{measureLabel}</strong>
          </p>
          <p className={styles.sub}>{section.flagCount} {section.flagCount === 1 ? 'issue' : 'issues'} · {typeLabel}</p>
          <p className={styles.tip}>Practice this section slowly first, then raise speed.</p>
        </div>

        {/* Divider */}
        <div className={styles.divider} />

        {/* Practice tools */}
        <div className={styles.tools}>

          {/* Row 1: Loop + Replay */}
          <div className={styles.toolRow}>
            <button
              className={`${styles.loopBtn} ${isSectionLooping ? styles.loopBtnActive : ''}`}
              onClick={handleLoop}
              disabled={!hasTs}
              title={!hasTs ? 'No timestamp data available for this section' : undefined}
            >
              {isSectionLooping
                ? <><StopIcon /> Stop loop</>
                : <><PlayIcon /> Loop section</>}
            </button>
            {hasTs && (
              <button className={styles.ghostBtn} onClick={handleReplay}>
                <ReplayIcon /> Replay
              </button>
            )}
            <button className={styles.ghostBtn} onClick={onReRecord}>
              <MicIcon /> Re-record
            </button>
          </div>

          {/* Row 2: Speed */}
          <div className={styles.toolRow}>
            <span className={styles.toolLabel}>Speed</span>
            {SPEEDS.map(s => (
              <button
                key={s}
                className={`${styles.speedBtn} ${videoSpeed === s ? styles.speedBtnActive : ''}`}
                onClick={() => onSpeedChange(s)}
              >
                {s === 1 ? '1×' : `${s}×`}
              </button>
            ))}
          </div>

          {/* Row 3: Metronome */}
          <div className={styles.toolRow}>
            <span className={styles.toolLabel}>♩</span>
            <button className={styles.bpmAdj} onClick={() => setBpm(b => Math.max(BPM_MIN, b - 5))}>−</button>
            <span className={styles.bpmVal}>{bpm}</span>
            <button className={styles.bpmAdj} onClick={() => setBpm(b => Math.min(BPM_MAX, b + 5))}>+</button>
            <button className={styles.tapBtn} onPointerDown={handleTap}>Tap</button>
            <button
              className={`${styles.metroToggle} ${metroPlaying ? styles.metroToggleActive : ''}`}
              onClick={toggleMetro}
            >
              {metroPlaying ? 'Stop' : 'Start'}
            </button>
            {metroPlaying && (
              <div className={styles.beatRow} aria-hidden="true">
                {[0, 1, 2, 3].map(i => (
                  <span key={i} className={`${styles.beatDot} ${beat === i ? styles.beatDotLit : ''} ${i === 0 && beat === 0 ? styles.beatDotAccent : ''}`} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Before/after teaser */}
        <div className={styles.teaser}>
          <span className={styles.teaserIcon}>◈</span>
          <span>Before/after comparison — <em>coming soon</em></span>
        </div>
      </div>
    </div>
  )
}

function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5,3 19,12 5,21"/>
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
    </svg>
  )
}

function ReplayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 .49-5"/>
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
    </svg>
  )
}
