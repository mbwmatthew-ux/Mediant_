import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './Page.module.css'

const BEATS_PER_MEASURE = 4
const BPM = 72
const MS_PER_BEAT = (60 / BPM) * 1000

function buildRows(flags) {
  if (!flags?.length) return []
  return flags.map(f => ({
    start:  Math.max(1, f.measure - 1),
    end:    f.measure + 2,
    flag:   { measure: f.measure, type: f.type, label: f.title || `${f.type} issue` },
  }))
}

export default function FollowAlong() {
  const nav = useNavigate()

  const [take, setTake]               = useState(undefined)
  const [playing, setPlaying]         = useState(false)
  const [measure, setMeasure]         = useState(1)
  const [beatInMeasure, setBeat]      = useState(0)
  const [looping, setLooping]         = useState(false)
  const [loopMeasures, setLoopMeasures] = useState(null)

  const intervalRef = useRef(null)
  const stateRef    = useRef({ measure: 1, beat: 0, looping: false, loopMeasures: null })

  useEffect(() => {
    try {
      const stored = localStorage.getItem('mediant_last_take')
      setTake(stored ? JSON.parse(stored) : null)
    } catch {
      setTake(null)
    }
  }, [])

  const scoreRows = buildRows(take?.flags)
  const totalMeasures = scoreRows.length
    ? scoreRows[scoreRows.length - 1].end
    : 0

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

    if (lp && lm && nextMeasure > lm[1]) {
      nextMeasure = lm[0]
    }

    if (nextMeasure > totalMeasures) {
      clearInterval(intervalRef.current)
      setPlaying(false)
      setMeasure(1)
      setBeat(0)
      return
    }

    setMeasure(nextMeasure)
    setBeat(nextBeat)
  }, [totalMeasures])

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
    setMeasure(scoreRows[0]?.start ?? 1)
    setBeat(0)
    setPlaying(false)
  }

  function toggleLoop() {
    if (looping) {
      setLooping(false)
      setLoopMeasures(null)
    } else {
      const activeRow = scoreRows.find(r => measure >= r.start && measure <= r.end) ?? scoreRows[0]
      if (activeRow) {
        setLooping(true)
        setLoopMeasures([activeRow.start, activeRow.end])
      }
    }
  }

  if (take === undefined) {
    return (
      <div className={styles.page}>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>▶</div>
          <p className={styles.analyzeSub}>Loading…</p>
        </div>
      </div>
    )
  }

  if (!take || !scoreRows.length) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <p className={styles.label}>Follow Along</p>
            <h1 className={styles.title}>Playback</h1>
          </div>
        </div>
        <div className={styles.analyzeScreen}>
          <div className={styles.analyzeIcon}>▶</div>
          <p className={styles.analyzeTitle}>No recording yet</p>
          <p className={styles.analyzeSub}>Upload a recording to use follow-along playback.</p>
          <button className={styles.primaryBtn} style={{ marginTop: 16 }} onClick={() => nav('/record')}>
            Upload a recording →
          </button>
        </div>
      </div>
    )
  }

  const activeRow = scoreRows.find(r => measure >= r.start && measure <= r.end) ?? scoreRows[0]
  const activeRowIdx = scoreRows.indexOf(activeRow)
  const posInRow = (measure - activeRow.start + beatInMeasure / BEATS_PER_MEASURE) /
                   (activeRow.end - activeRow.start + 1)
  const playheadPct    = Math.min(posInRow * 100, 99)
  const globalProgress = ((measure - 1) + beatInMeasure / BEATS_PER_MEASURE) / totalMeasures * 100

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.label}>Follow Along</p>
          <h1 className={styles.title}>Playback</h1>
        </div>
        <button className={styles.ghostBtn} onClick={() => nav('/summary')}>Session recap →</button>
      </div>

      <div className={styles.playerCard}>
        <div className={styles.playerMeta}>
          <strong>{take.piece_title || 'Untitled'}</strong>
          <span className={styles.playerPos}>Measure {measure} of {totalMeasures}</span>
          {looping && loopMeasures && (
            <span className={styles.loopBadge}>Looping m.{loopMeasures[0]}–{loopMeasures[1]}</span>
          )}
        </div>

        <div className={styles.timeline} onClick={(e) => {
          const pct = e.nativeEvent.offsetX / e.currentTarget.clientWidth
          const newMeasure = Math.max(1, Math.round(1 + pct * totalMeasures))
          setMeasure(Math.min(newMeasure, totalMeasures))
          setBeat(0)
        }}>
          <div className={styles.timelineFill} style={{ width: `${globalProgress}%` }} />
        </div>

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

      <p className={styles.tempoInfo}>{BPM} BPM · {take.piece_composer || ''}</p>

      <div className={styles.followScore}>
        {scoreRows.map((r, i) => {
          const isActive      = i === activeRowIdx
          const isLoopTarget  = looping && loopMeasures && r.start === loopMeasures[0]
          return (
            <div
              key={i}
              className={`${styles.followRow} ${isActive ? styles.followRowActive : ''} ${r.flag ? styles.followRowFlagged : ''} ${isLoopTarget ? styles.followRowLooping : ''}`}
            >
              <div className={styles.staffLines}>
                {[...Array(5)].map((_, li) => <div key={li} className={styles.staffLine} />)}
              </div>

              <div className={styles.measureLabels}>
                {Array.from({ length: r.end - r.start + 1 }, (_, k) => r.start + k).map(mn => (
                  <span key={mn} className={`${styles.measureLabel} ${mn === measure ? styles.measureLabelActive : ''}`}>
                    m.{mn}
                  </span>
                ))}
              </div>

              {isActive && (
                <div className={styles.beatDots}>
                  {[...Array(BEATS_PER_MEASURE)].map((_, bi) => (
                    <span key={bi} className={`${styles.beatDot} ${bi <= beatInMeasure ? styles.beatDotActive : ''}`} />
                  ))}
                </div>
              )}

              {isActive && (
                <div className={styles.playhead} style={{ left: `${playheadPct}%` }} />
              )}

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
        {activeRow.flag && (
          <p className={styles.followFlagCaption}>
            ⚑ {activeRow.flag.label}
          </p>
        )}
      </div>
    </div>
  )
}
