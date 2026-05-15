import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './Page.module.css'

const TOTAL_MEASURES = 36
const BPM = 60         // quarter note = 60 bpm for a slow, readable demo
const MS_PER_BEAT = (60 / BPM) * 1000
const BEATS_PER_MEASURE = 3

// 4 rows of measures shown in the score view
const SCORE_ROWS = [
  { start: 12, end: 15, flag: null },
  { start: 16, end: 19, flag: { measure: 16, type: 'timing', label: 'Timing issue — left hand enters early here.' } },
  { start: 28, end: 31, flag: { measure: 28, type: 'dynamics', label: 'Dynamics flatten — keep the phrase moving.' } },
  { start: 33, end: 36, flag: { measure: 33, type: 'voicing', label: 'Voicing — inner voices too prominent.' } },
]

// Map logical measure → row index (for scrolling / highlighting)
function measureToRow(m) {
  for (let i = 0; i < SCORE_ROWS.length; i++) {
    if (m >= SCORE_ROWS[i].start && m <= SCORE_ROWS[i].end) return i
  }
  return 0
}

export default function FollowAlong() {
  const nav = useNavigate()
  const [playing, setPlaying]           = useState(false)
  const [measure, setMeasure]           = useState(12)  // current measure
  const [beatInMeasure, setBeat]        = useState(0)   // 0-2
  const [looping, setLooping]           = useState(false)
  const [loopMeasures, setLoopMeasures] = useState(null) // null | [start, end]

  const intervalRef = useRef(null)
  const stateRef    = useRef({ measure: 12, beat: 0, looping: false, loopMeasures: null })

  // Keep ref in sync so the interval callback can read current state
  useEffect(() => {
    stateRef.current = { measure, beat: beatInMeasure, looping, loopMeasures }
  }, [measure, beatInMeasure, looping, loopMeasures])

  const tick = useCallback(() => {
    const { measure: m, beat: b, looping: lp, loopMeasures: lm } = stateRef.current
    let nextBeat    = b + 1
    let nextMeasure = m

    if (nextBeat >= BEATS_PER_MEASURE) {
      nextBeat = 0
      nextMeasure = m + 1
    }

    // Loop section
    if (lp && lm && nextMeasure > lm[1]) {
      nextMeasure = lm[0]
    }

    // End of piece
    if (nextMeasure > TOTAL_MEASURES + 12) {
      clearInterval(intervalRef.current)
      setPlaying(false)
      setMeasure(12)
      setBeat(0)
      return
    }

    setMeasure(nextMeasure)
    setBeat(nextBeat)
  }, [])

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(tick, MS_PER_BEAT)
    } else {
      clearInterval(intervalRef.current)
    }
    return () => clearInterval(intervalRef.current)
  }, [playing, tick])

  function togglePlay() { setPlaying(p => !p) }

  function handleBack() {
    setMeasure(12)
    setBeat(0)
    setPlaying(false)
  }

  function toggleLoop() {
    if (looping) {
      setLooping(false)
      setLoopMeasures(null)
    } else {
      // Loop the current row
      const row = SCORE_ROWS[measureToRow(measure)]
      setLooping(true)
      setLoopMeasures([row.start, row.end])
    }
  }

  const activeRow = measureToRow(measure)
  const row = SCORE_ROWS[activeRow]
  // Position of playhead within the row (0–1)
  const posInRow = (measure - row.start + beatInMeasure / BEATS_PER_MEASURE) /
                   (row.end - row.start + 1)
  const playheadPct = Math.min(posInRow * 100, 99)

  // Global progress for the timeline (across all displayed measures)
  const totalDisplayed = TOTAL_MEASURES
  const globalProgress = ((measure - 12) + beatInMeasure / BEATS_PER_MEASURE) / totalDisplayed * 100

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Follow Along</p>
          <h1 className={styles.title}>Playback</h1>
        </div>
        <button className={styles.ghostBtn} onClick={() => nav('/summary')}>Session recap →</button>
      </div>

      {/* Player bar */}
      <div className={styles.playerCard}>
        <div className={styles.playerMeta}>
          <strong>Clair de Lune</strong>
          <span className={styles.playerPos}>Measure {measure} of {TOTAL_MEASURES + 12}</span>
          {looping && <span className={styles.loopBadge}>Looping m.{loopMeasures[0]}–{loopMeasures[1]}</span>}
        </div>

        {/* Timeline */}
        <div className={styles.timeline} onClick={(e) => {
          const pct = e.nativeEvent.offsetX / e.currentTarget.clientWidth
          const newMeasure = Math.round(12 + pct * TOTAL_MEASURES)
          setMeasure(Math.max(12, Math.min(newMeasure, TOTAL_MEASURES + 12)))
          setBeat(0)
        }}>
          <div className={styles.timelineFill} style={{ width: `${globalProgress}%` }} />
        </div>

        {/* Controls */}
        <div className={styles.controls}>
          <button className={styles.controlPill} onClick={handleBack}>↩ Reset</button>
          <button
            className={`${styles.controlPill} ${playing ? styles.controlPillActive : ''}`}
            onClick={togglePlay}
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button
            className={`${styles.controlPill} ${looping ? styles.controlPillActive : ''}`}
            onClick={toggleLoop}
          >
            ↻ Loop
          </button>
        </div>
      </div>

      {/* Tempo info */}
      <p className={styles.tempoInfo}>{BPM} BPM · 3/4 · Clair de Lune in D♭ major</p>

      {/* Score rows with live playhead */}
      <div className={styles.followScore}>
        {SCORE_ROWS.map((r, i) => {
          const isActive = i === activeRow
          const isLoopTarget = looping && loopMeasures && r.start === loopMeasures[0]
          return (
            <div
              key={i}
              className={`${styles.followRow} ${isActive ? styles.followRowActive : ''} ${r.flag ? styles.followRowFlagged : ''} ${isLoopTarget ? styles.followRowLooping : ''}`}
            >
              {/* Staff lines */}
              <div className={styles.staffLines}>
                {[...Array(5)].map((_, li) => <div key={li} className={styles.staffLine} />)}
              </div>

              {/* Measure labels */}
              <div className={styles.measureLabels}>
                {[r.start, r.start + 1, r.start + 2, r.end].map(mn => (
                  <span key={mn} className={`${styles.measureLabel} ${mn === measure ? styles.measureLabelActive : ''}`}>
                    m.{mn}
                  </span>
                ))}
              </div>

              {/* Beat dots — show beats in the active measure */}
              {isActive && (
                <div className={styles.beatDots}>
                  {[...Array(BEATS_PER_MEASURE)].map((_, bi) => (
                    <span key={bi} className={`${styles.beatDot} ${bi <= beatInMeasure ? styles.beatDotActive : ''}`} />
                  ))}
                </div>
              )}

              {/* Playhead */}
              {isActive && (
                <div className={styles.playhead} style={{ left: `${playheadPct}%` }} />
              )}

              {/* Flag label */}
              {r.flag && (
                <div className={styles.followFlag}>
                  <span className={styles.followFlagDot} />
                  {r.flag.label}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className={styles.followCaption}>
        <strong>Measure {measure}, beat {beatInMeasure + 1}</strong>
        {SCORE_ROWS[activeRow].flag && (
          <p className={styles.followFlagCaption}>
            ⚑ {SCORE_ROWS[activeRow].flag.label}
          </p>
        )}
      </div>
    </div>
  )
}
