import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'

// Step 0: centered intro (no spotlight)
// Step 1: spotlight the Session Summary tab button
const STEPS = [
  {
    title: 'Your analysis is ready',
    body: 'Mediant reviewed your recording measure by measure. Each flag in the INSIGHTS panel points to a specific moment — tap the timestamp to jump there, or hit Loop to replay just that measure.',
    icon: '✦',
  },
  {
    targetLabel: 'analysis-summary-tab',
    title: 'Session Summary & Masterclasses',
    body: 'Open this tab to see your full score breakdown, compare against past takes of the same piece, and browse expert masterclass videos curated for this exact work.',
  },
]

const PAD = 8

export default function AnalysisOnboarding({ onClose }) {
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState(null)

  const current = STEPS[step]
  const isLast = step === STEPS.length - 1
  const hasTarget = !!rect

  useEffect(() => {
    if (!current.targetLabel) { setRect(null); return }
    // Use rAF to ensure the layout has painted before measuring
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-onboarding-label="${current.targetLabel}"]`)
      if (el) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        setRect(el.getBoundingClientRect())
      } else {
        setRect(null)
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [step, current.targetLabel])

  function next() {
    if (isLast) { done() } else { setStep(s => s + 1) }
  }

  function done() {
    localStorage.setItem('mediant_analysis_intro', '1')
    onClose()
  }

  const CARD_W = hasTarget ? 308 : 400

  // For targeted steps: position card below (or above) the element
  function targetCardStyle() {
    if (!rect) return null
    const CARD_H_EST = 200
    const spaceBelow = window.innerHeight - rect.bottom
    const showBelow = spaceBelow >= CARD_H_EST || spaceBelow >= rect.top
    const top = showBelow ? rect.bottom + 12 : Math.max(8, rect.top - CARD_H_EST - 12)
    const left = Math.max(8, Math.min(
      Math.round(rect.left + rect.width / 2 - CARD_W / 2),
      window.innerWidth - CARD_W - 8,
    ))
    return { position: 'fixed', top, left, width: CARD_W, zIndex: 1002 }
  }

  const cardContent = (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 16,
      padding: hasTarget ? '22px 24px' : '36px 32px',
      textAlign: hasTarget ? 'left' : 'center',
      boxShadow: '0 8px 32px rgba(0,0,0,.5)',
      width: CARD_W,
    }}>
      {!hasTarget && current.icon && (
        <div style={{ color: 'var(--accent)', fontSize: '2rem', marginBottom: 14 }}>
          {current.icon}
        </div>
      )}
      <h2 style={{ color: 'var(--text)', fontSize: hasTarget ? '1rem' : '1.15rem', fontWeight: 600, margin: '0 0 8px' }}>
        {current.title}
      </h2>
      <p style={{ color: 'var(--text-soft)', fontSize: '0.88rem', lineHeight: 1.65, margin: '0 0 18px' }}>
        {current.body}
      </p>

      <div style={{ display: 'flex', gap: 5, marginBottom: 16, justifyContent: hasTarget ? 'flex-start' : 'center' }}>
        {STEPS.map((_, i) => (
          <div key={i} onClick={() => setStep(i)} style={{
            width: i === step ? 18 : 6,
            height: 6,
            borderRadius: 3,
            background: i === step ? 'var(--accent)' : 'var(--border)',
            cursor: 'pointer',
            transition: 'width 200ms ease',
            flexShrink: 0,
          }} />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexDirection: hasTarget ? 'row' : 'column' }}>
        <button onClick={next} style={{
          flex: hasTarget ? 1 : undefined,
          width: hasTarget ? undefined : '100%',
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '9px 16px',
          fontSize: '0.88rem',
          fontWeight: 600,
          cursor: 'pointer',
        }}>
          {isLast ? 'Got it' : 'Next →'}
        </button>
        <button onClick={done} style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: '0.82rem',
          cursor: 'pointer',
          padding: '4px',
          whiteSpace: 'nowrap',
        }}>
          Skip
        </button>
      </div>
    </div>
  )

  return createPortal(
    <>
      <style>{`@keyframes ob-pulse{0%,100%{box-shadow:0 0 0 9999px rgba(10,12,14,.82),0 0 0 3px var(--accent)}50%{box-shadow:0 0 0 9999px rgba(10,12,14,.82),0 0 0 5px var(--accent),0 0 16px 4px rgba(59,122,87,.45)}}`}</style>

      {/* Backdrop — transparent when spotlight active, dark when centered */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: hasTarget ? 'transparent' : 'rgba(10,12,14,.82)' }}
        onClick={e => { if (e.target === e.currentTarget) done() }}
      />

      {/* Spotlight ring around targeted element */}
      {hasTarget && rect && (
        <div style={{
          position: 'fixed',
          left: rect.left - PAD,
          top: rect.top - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          borderRadius: 10,
          zIndex: 1001,
          pointerEvents: 'none',
          animation: 'ob-pulse 2s ease-in-out infinite',
        }} />
      )}

      {/* Card: full-screen flex center for step 0, explicit position for targeted steps */}
      {hasTarget ? (
        <div style={targetCardStyle()}>
          {cardContent}
        </div>
      ) : (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1002,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{ pointerEvents: 'auto' }}>
            {cardContent}
          </div>
        </div>
      )}
    </>,
    document.body,
  )
}
