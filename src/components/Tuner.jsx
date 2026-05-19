import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './Tuner.module.css'

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length
  const HALF = Math.floor(SIZE / 2)

  let sum = 0
  for (let i = 0; i < SIZE; i++) sum += buf[i] * buf[i]
  if (Math.sqrt(sum / SIZE) < 0.008) return -1  // silence

  let best = -1, bestCorr = 0, lastCorr = 1, found = false
  for (let t = 1; t < HALF; t++) {
    let corr = 0
    for (let i = 0; i < HALF; i++) corr += Math.abs(buf[i] - buf[i + t])
    corr = 1 - corr / HALF
    if (corr > 0.9 && corr > lastCorr) {
      found = true
      if (corr > bestCorr) { bestCorr = corr; best = t }
    } else if (found) {
      return sampleRate / best
    }
    lastCorr = corr
  }
  return best > 0 ? sampleRate / best : -1
}

function freqToNote(freq) {
  if (!freq || freq <= 0) return null
  const n     = 12 * Math.log2(freq / 440) + 69
  const midi  = Math.round(n)
  const cents = Math.round((n - midi) * 100)
  return {
    name:   NOTES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    cents,
    freq:   Math.round(freq * 10) / 10,
  }
}

function centsColor(cents) {
  const abs = Math.abs(cents)
  if (abs < 8)  return 'var(--hero-green)'
  if (abs < 20) return 'var(--gold)'
  return 'var(--coral)'
}

export default function Tuner() {
  const [active, setActive] = useState(false)
  const [note,   setNote]   = useState(null)
  const [error,  setError]  = useState(null)

  const ctxRef      = useRef(null)
  const analyserRef = useRef(null)
  const streamRef   = useRef(null)
  const rafRef      = useRef(null)
  const bufRef      = useRef(null)

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close()
    ctxRef.current = null
    analyserRef.current = null
    streamRef.current = null
    bufRef.current = null
    setNote(null)
    setActive(false)
  }, [])

  const start = useCallback(async () => {
    setError(null)
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const ctx      = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      ctx.createMediaStreamSource(stream).connect(analyser)

      ctxRef.current      = ctx
      analyserRef.current = analyser
      streamRef.current   = stream
      bufRef.current      = new Float32Array(analyser.fftSize)

      setActive(true)

      function tick() {
        analyserRef.current.getFloatTimeDomainData(bufRef.current)
        const freq = autoCorrelate(bufRef.current, ctx.sampleRate)
        setNote(freq > 20 && freq < 5000 ? freqToNote(freq) : null)
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch {
      setError('Microphone access denied. Allow microphone permissions and try again.')
    }
  }, [])

  useEffect(() => () => stop(), [stop])

  const color     = note ? centsColor(note.cents) : 'rgba(88,121,101,0.2)'
  const needlePct = note ? Math.max(2, Math.min(98, 50 + note.cents)) : 50
  const tuned     = note && Math.abs(note.cents) < 8

  return (
    <div className={styles.tuner}>
      <div className={styles.tunerTop}>
        <div>
          <p className={styles.tunerLabel}>Soundcheck</p>
          <p className={styles.tunerSub}>Tune your instrument using your microphone</p>
        </div>
        <button
          className={`${styles.tunerBtn} ${active ? styles.tunerBtnActive : ''}`}
          onClick={active ? stop : start}
        >
          {active ? '■ Stop' : '♩ Start tuning'}
        </button>
      </div>

      {error && <p className={styles.tunerError}>{error}</p>}

      {active && (
        <div className={styles.display}>
          {/* Note name */}
          <div className={styles.noteWrap}>
            <span className={styles.noteName} style={{ color }}>
              {note ? note.name : '—'}
            </span>
            {note && <sup className={styles.noteOctave}>{note.octave}</sup>}
          </div>

          {/* Gauge */}
          <div className={styles.gaugeWrap}>
            <span className={styles.gaugeSide}>♭</span>
            <div className={styles.gaugeTrack}>
              <div className={styles.gaugeCenter} />
              <div
                className={styles.needle}
                style={{ left: `${needlePct}%`, background: color }}
              />
            </div>
            <span className={styles.gaugeSide}>♯</span>
          </div>

          {/* Status line */}
          <p className={styles.status}>
            {!note && <span className={styles.statusMuted}>Listening for a note…</span>}
            {note && tuned  && <span style={{ color: 'var(--hero-green)', fontWeight: 600 }}>In tune ✓</span>}
            {note && !tuned && (
              <span style={{ color }}>
                {note.cents > 0 ? `+${note.cents}` : note.cents} cents {note.cents > 0 ? 'sharp' : 'flat'}
              </span>
            )}
            {note && <span className={styles.freq}>{note.freq} Hz</span>}
          </p>
        </div>
      )}
    </div>
  )
}
