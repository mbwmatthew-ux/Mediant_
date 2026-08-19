import { useEffect, useRef, useState } from 'react'

/**
 * True when the OS asks for reduced motion. Every animated surface should read
 * this and render its FINAL state immediately rather than simply skipping the
 * animation — a progress ring stuck at 0 is worse than one that never moved.
 */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

/**
 * Flips to true one frame after mount, so CSS transitions have a "from" state
 * to move away from. Rendering the final value on the first paint would make
 * the browser skip the transition entirely — there would be nothing to
 * interpolate.
 *
 * `delay` staggers a group without hand-writing a timeout per element.
 */
export function useMounted(delay = 0) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let raf2 = 0
    // Two nested frames: the first commits the "from" state to the compositor,
    // the second changes it. A single frame is unreliable here — React may
    // batch both into the same paint and the transition never runs.
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (delay) { const t = setTimeout(() => setOn(true), delay); return () => clearTimeout(t) }
        setOn(true)
      })
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [delay])
  return on
}

/**
 * Counts from 0 to `target`, easing out. Returns the target unchanged when
 * motion is reduced or the value is not a finite number.
 */
export function useCountUp(target, { duration = 1100, reduced = false } = {}) {
  const valid = Number.isFinite(target)
  const [value, setValue] = useState(valid && !reduced ? 0 : target)
  const frame = useRef(0)

  useEffect(() => {
    if (!valid || reduced) { setValue(target); return }
    const start = performance.now()
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration)
      // easeOutCubic — fast start, gentle settle. Matches the card entrance.
      setValue(target * (1 - Math.pow(1 - t, 3)))
      if (t < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [target, duration, reduced, valid])

  return valid ? value : target
}
