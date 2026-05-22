import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './Tuner.module.css'

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length
  const HALF = Math.floor(SIZE / 2)
  let sum = 0
  for (let i = 0; i < SIZE; i++) sum += buf[i] * buf[i]
  if (Math.sqrt(sum / SIZE) < 0.008) return -1

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

export default function TunerModal({ onClose }) {
  const [note,  setNote]  = useState(null)
  const [error, setError] = useState(null)
  const [active, setActive] = useState(false)

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

    // Check if already denied via Permissions API before prompting
    try {
      const perm = await navigator.permissions.query({ name: 'microphone' })
      if (perm.state === 'denied') {
        setError('denied')
        return
      }
    } catch { /* Permissions API not supported — proceed anyway */ }

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
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setError('denied')
      } else if (err.name === 'NotFoundError') {
        setError('notfound')
      } else {
        setError('unknown')
      }
    }
  }, [])

  // Auto-start when modal opens
  useEffect(() => { start() }, [start])
  useEffect(() => () => stop(), [stop])

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') { stop(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stop, onClose])

  const color     = note ? centsColor(note.cents) : 'rgba(88,121,101,0.3)'
  const needlePct = note ? Math.max(2, Math.min(98, 50 + note.cents)) : 50
  const tuned     = note && Math.abs(note.cents) < 8

  return (
    <div className={styles.backdrop} onClick={e => e.target === e.currentTarget && (stop(), onClose())}>
      <div className={styles.modal}>

        <div className={styles.modalHeader}>
          <p className={styles.modalTitle}>Instrument Tuner</p>
          <button className={styles.closeBtn} onClick={() => { stop(); onClose() }}>✕</button>
        </div>

        {/* Error states */}
        {error === 'denied' && (
          <div className={styles.errorBox}>
            <p className={styles.errorTitle}>Microphone access blocked</p>
            <p className={styles.errorBody}>
              Your browser has blocked microphone access for this site. To fix it:
            </p>
            <ol className={styles.errorSteps}>
              <li>Click the <strong>lock icon</strong> (or camera icon) in your browser's address bar</li>
              <li>Find <strong>Microphone</strong> and set it to <strong>Allow</strong></li>
              <li>Reload the page and try again</li>
            </ol>
            <button className={styles.retryBtn} onClick={start}>Try again</button>
          </div>
        )}
        {error === 'notfound' && (
          <div className={styles.errorBox}>
            <p className={styles.errorTitle}>No microphone found</p>
            <p className={styles.errorBody}>Connect a microphone or headset and try again.</p>
            <button className={styles.retryBtn} onClick={start}>Try again</button>
          </div>
        )}
        {error === 'unknown' && (
          <div className={styles.errorBox}>
            <p className={styles.errorTitle}>Could not access microphone</p>
            <p className={styles.errorBody}>Check your browser and system microphone settings, then try again.</p>
            <button className={styles.retryBtn} onClick={start}>Try again</button>
          </div>
        )}

        {/* Tuner display */}
        {!error && (
          <div className={styles.display}>
            <div className={styles.noteWrap}>
              <span className={styles.noteName}>
                {note ? note.name : '—'}
              </span>
              {note && <sup className={styles.noteOctave}>{note.octave}</sup>}
            </div>

            <div className={styles.gaugeWrap}>
              <span className={styles.gaugeSide}>♭</span>
              <div className={styles.gaugeTrack}>
                <div className={styles.gaugeCenter} />
                <div className={styles.needle} style={{ left: `${needlePct}%`, background: color }} />
              </div>
              <span className={styles.gaugeSide}>♯</span>
            </div>

            <p className={styles.status}>
              {!note && !active && <span className={styles.statusMuted}>Starting…</span>}
              {!note && active  && <span className={styles.statusMuted}>Listening for a note…</span>}
              {note && tuned   && <span style={{ color: 'var(--hero-green)', fontWeight: 600 }}>In tune ✓</span>}
              {note && !tuned  && (
                <span style={{ color }}>
                  {note.cents > 0 ? `+${note.cents}` : note.cents} cents {note.cents > 0 ? 'sharp ↑' : 'flat ↓'}
                </span>
              )}
              {note && <span className={styles.freq}>{note.freq} Hz</span>}
            </p>

            <p className={styles.reference}>Reference: A4 = 440 Hz</p>
          </div>
        )}
      </div>
    </div>
  )
}
