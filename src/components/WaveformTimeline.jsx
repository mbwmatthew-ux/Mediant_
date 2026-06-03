import { useEffect, useRef, useMemo } from 'react'
import styles from './WaveformTimeline.module.css'

const TYPE_COLOR = {
  intonation:   'var(--coral)',
  rhythm:       'var(--gold)',
  timing:       'var(--gold)',
  dynamics:     'var(--coral)',
  technique:    'var(--mint)',
  articulation: 'var(--mint)',
  tone:         'var(--mint)',
  phrasing:     'var(--gold)',
  expression:   'var(--gold)',
  posture:      'var(--mint)',
}

export const WAVEFORM_GROUPS = [
  {
    key: 'intonation',
    label: 'Intonation',
    types: ['intonation'],
    color: 'var(--coral)',
    desc: 'Pitch accuracy — notes that are sharp or flat',
  },
  {
    key: 'rhythm',
    label: 'Rhythm & Timing',
    types: ['rhythm', 'timing', 'phrasing', 'expression'],
    color: 'var(--gold)',
    desc: 'Beat accuracy, note duration, and rhythmic consistency',
  },
  {
    key: 'dynamics',
    label: 'Dynamics',
    types: ['dynamics'],
    color: 'var(--coral)',
    desc: 'Volume control and expressive range',
  },
  {
    key: 'technique',
    label: 'Technique',
    types: ['technique', 'articulation', 'tone', 'posture'],
    color: 'var(--mint)',
    desc: 'Mechanical execution and sound production',
  },
]

function typeColor(type) {
  return TYPE_COLOR[(type ?? '').toLowerCase()] ?? 'var(--accent)'
}

function formatTs(s) {
  if (s == null || !Number.isFinite(Number(s))) return ''
  const total = Math.round(Number(s))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const BAR_COUNT = 64

export default function WaveformTimeline({ flags = [], duration = 0, videoRef, activeFlag, onFlagClick }) {
  const trackRef    = useRef(null)
  const playheadRef = useRef(null)

  const hasTimingData = useMemo(
    () => flags.some(f => Number(f.timestamp_start) > 0),
    [flags],
  )

  // Derive duration from flags when no video has loaded yet
  const effectiveDuration = useMemo(() => {
    if (duration > 0) return duration
    if (!hasTimingData) return 0
    const max = flags.reduce((m, f) => {
      const ts = Number(f.timestamp_end ?? f.timestamp_start) || 0
      return Math.max(m, ts)
    }, 0)
    return max > 0 ? max * 1.2 : 0
  }, [duration, flags, hasTimingData])

  const bars = useMemo(() => {
    if (!hasTimingData || effectiveDuration <= 0) {
      return Array.from({ length: BAR_COUNT }, (_, i) => ({
        height: 10 + Math.sin(i * 0.31) * 5 + Math.sin(i * 0.87 + 1.1) * 3,
        color: 'var(--accent)',
        opacity: 0.13,
      }))
    }

    return Array.from({ length: BAR_COUNT }, (_, i) => {
      const tStart = (i / BAR_COUNT) * effectiveDuration
      const tEnd   = ((i + 1) / BAR_COUNT) * effectiveDuration
      const inWindow = flags.filter(f => {
        const ts = Number(f.timestamp_start)
        return Number.isFinite(ts) && ts >= tStart && ts < tEnd
      })

      if (inWindow.length === 0) return { height: 7, color: 'var(--surface-border)', opacity: 0.6 }

      const dominant = inWindow.reduce((best, f) =>
        (f.confidence ?? 0) > (best.confidence ?? 0) ? f : best, inWindow[0])
      return {
        height: Math.min(62, 16 + inWindow.length * 22),
        color: typeColor(dominant.type),
        opacity: 1,
      }
    })
  }, [flags, effectiveDuration, hasTimingData])

  const markers = useMemo(() => {
    if (!hasTimingData || effectiveDuration <= 0) return []
    return flags
      .map((f, i) => {
        const ts = Number(f.timestamp_start)
        if (!Number.isFinite(ts) || ts <= 0) return null
        return {
          id:      `flag_${i}`,
          pct:     Math.min(99.2, (ts / effectiveDuration) * 100),
          color:   typeColor(f.type),
          measure: f.measure,
          title:   f.title,
          type:    f.type,
        }
      })
      .filter(Boolean)
  }, [flags, effectiveDuration, hasTimingData])

  const presentGroups = useMemo(() => {
    const types = new Set(flags.map(f => (f.type ?? '').toLowerCase()))
    return WAVEFORM_GROUPS.filter(g => g.types.some(t => types.has(t)))
  }, [flags])

  // Sync playhead via RAF — no React re-renders on every frame
  useEffect(() => {
    const video = videoRef?.current
    if (!video || effectiveDuration <= 0) return
    let raf
    function tick() {
      if (playheadRef.current) {
        const pct = Math.min(100, (video.currentTime / effectiveDuration) * 100)
        playheadRef.current.style.left = `${pct}%`
        playheadRef.current.style.opacity = video.currentTime > 0.1 ? '1' : '0'
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [videoRef, effectiveDuration])

  function handleTrackClick(e) {
    if (!trackRef.current || effectiveDuration <= 0) return
    const rect = trackRef.current.getBoundingClientRect()
    const pct  = (e.clientX - rect.left) / rect.width
    const seek = Math.max(0, Math.min(effectiveDuration, pct * effectiveDuration))
    if (videoRef?.current) videoRef.current.currentTime = seek
  }

  return (
    <div className={styles.root}>
      {/* Clickable track */}
      <div className={styles.track} ref={trackRef} onClick={handleTrackClick}>
        {/* Bars */}
        <div className={styles.bars}>
          {bars.map((bar, i) => (
            <div
              key={i}
              className={styles.bar}
              style={{ height: `${bar.height}px`, background: bar.color, opacity: bar.opacity }}
            />
          ))}
        </div>

        {/* Flag markers — float above bars */}
        {markers.map(m => (
          <button
            key={m.id}
            className={`${styles.marker} ${activeFlag === m.id ? styles.markerActive : ''}`}
            style={{ left: `${m.pct}%`, '--mc': m.color }}
            title={`m.${m.measure} · ${m.title}`}
            onClick={e => { e.stopPropagation(); onFlagClick?.(m.id) }}
          />
        ))}

        {/* Playhead line */}
        <div className={styles.playhead} ref={playheadRef} style={{ opacity: 0 }} />
      </div>

      {/* Footer: timestamps + legend */}
      <div className={styles.footer}>
        <span className={styles.timestamp}>0:00</span>

        {hasTimingData && presentGroups.length > 0 ? (
          <div className={styles.legend}>
            {presentGroups.map(g => (
              <span key={g.key} className={styles.legendItem} style={{ '--lc': g.color }}>
                {g.label}
              </span>
            ))}
          </div>
        ) : !hasTimingData ? (
          <span className={styles.noData}>Timing breakdown not available for this take</span>
        ) : null}

        {effectiveDuration > 0 && <span className={styles.timestamp}>{formatTs(effectiveDuration)}</span>}
      </div>
    </div>
  )
}
