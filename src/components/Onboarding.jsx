import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const STEPS = [
  {
    icon: '♩',
    title: 'Welcome to Mediant',
    body: 'Your personal music performance coach. Upload a recording of yourself playing and get measure-level feedback — just like working with a professional teacher.',
  },
  {
    navLabel: 'Dashboard',
    title: 'Your home base',
    body: 'See your latest analysis, technique tips from your most recent session, your practice streak, and your score history at a glance.',
  },
  {
    navLabel: 'Record',
    title: 'Upload a recording',
    body: 'Drop in your sheet music and a video of yourself playing. Mediant reads the score, listens to your performance, and flags specific measures to work on.',
  },
  {
    navLabel: 'Library',
    title: 'Your music library',
    body: 'Upload and organise your sheet music collection. Mediant reads each piece and fills in the key, time signature, composer, and difficulty level automatically.',
  },
  {
    navLabel: 'Sessions',
    title: 'All your recordings',
    body: 'Every take you upload is saved here. Tap any session to jump straight back into the full score review and coaching notes.',
  },
  {
    navLabel: 'Progress',
    title: 'Track your improvement',
    body: 'See your scores and flags over time. Generate a weekly or monthly Mediant practice report that identifies recurring patterns and sets concrete goals.',
  },
  {
    navLabel: 'Discussion',
    title: 'Ask Mediant anything',
    body: 'Chat with Mediant at any time — about technique, theory, practice strategy, or anything flagged in a recent session.',
  },
  {
    navLabel: 'Metronome',
    title: 'Built-in metronome',
    body: 'Tap the metronome in the sidebar to open a click track. Set any tempo from Largo to Prestissimo, choose your time signature, and use tap tempo to match a recording.',
  },
  {
    icon: '✓',
    title: "You're all set",
    body: 'Start by uploading your first recording. A phone video is all you need — no fancy equipment required.',
    cta: 'Upload a recording',
    action: 'record',
  },
]

const PAD = 6

function findNavElement(label) {
  const spans = document.querySelectorAll('aside span')
  for (const span of spans) {
    if (span.textContent?.trim() === label) return span.parentElement
  }
  return null
}

export default function Onboarding({ onClose }) {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState(null)
  const current = STEPS[step]
  const isLast = step === STEPS.length - 1
  const hasNav = !!current.navLabel

  useEffect(() => {
    if (!current.navLabel) { setRect(null); return }
    const t = setTimeout(() => {
      const el = findNavElement(current.navLabel)
      setRect(el ? el.getBoundingClientRect() : null)
    }, 60)
    return () => clearTimeout(t)
  }, [step, current.navLabel])

  function markOnboarded() {
    localStorage.setItem('mediant_onboarded', '1')
    supabase.auth.updateUser({ data: { onboarded: true } }).catch(() => {})
  }

  function handleCta() {
    if (isLast) {
      markOnboarded()
      onClose()
      nav('/record')
    } else {
      setStep(s => s + 1)
    }
  }

  function handleSkip() {
    markOnboarded()
    onClose()
  }

  // Card position: to the right of the highlighted element, or centred
  const cardStyle = rect ? {
    position: 'fixed',
    left: rect.right + 18,
    top: Math.min(
      Math.max(16, rect.top + rect.height / 2 - 130),
      window.innerHeight - 340,
    ),
    width: 300,
    zIndex: 1002,
  } : {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 420,
    zIndex: 1002,
  }

  return (
    <>
      {/* inject pulse keyframe once */}
      <style>{`@keyframes ob-pulse{0%,100%{box-shadow:0 0 0 9999px rgba(10,12,14,.82),0 0 0 3px var(--accent)}50%{box-shadow:0 0 0 9999px rgba(10,12,14,.82),0 0 0 5px var(--accent),0 0 16px 4px rgba(88,121,101,.45)}}`}</style>

      {/* Base overlay — captures backdrop clicks */}
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: hasNav && rect ? 'transparent' : 'rgba(10,12,14,.82)',
        }}
        onClick={e => { if (e.target === e.currentTarget) handleSkip() }}
      />

      {/* Spotlight ring over the nav element */}
      {hasNav && rect && (
        <div
          style={{
            position: 'fixed',
            left:   rect.left   - PAD,
            top:    rect.top    - PAD,
            width:  rect.width  + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 10,
            zIndex: 1001,
            pointerEvents: 'none',
            animation: 'ob-pulse 2s ease-in-out infinite',
          }}
        />
      )}

      {/* Arrow pointing left to the nav item */}
      {hasNav && rect && (
        <div style={{
          position: 'fixed',
          left: rect.right + 6,
          top: rect.top + rect.height / 2 - 8,
          zIndex: 1003,
          pointerEvents: 'none',
          color: 'var(--accent)',
          fontSize: '1.1rem',
          lineHeight: 1,
        }}>
          ›
        </div>
      )}

      {/* Description card */}
      <div style={cardStyle}>
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: hasNav ? '22px 24px' : '40px 36px',
          textAlign: hasNav ? 'left' : 'center',
          boxShadow: '0 8px 32px rgba(0,0,0,.4)',
        }}>

          {/* Centred icon for non-nav steps */}
          {!hasNav && current.icon && (
            <div style={{ color: 'var(--accent)', fontSize: '2rem', marginBottom: 16, textAlign: 'center' }}>
              {current.icon}
            </div>
          )}

          {/* Tab badge */}
          {current.navLabel && (
            <div style={{
              display: 'inline-block',
              background: 'rgba(88,121,101,.14)',
              border: '1px solid rgba(88,121,101,.28)',
              borderRadius: 20,
              color: 'var(--accent)',
              fontSize: '0.7rem',
              fontWeight: 700,
              letterSpacing: '0.07em',
              marginBottom: 10,
              padding: '3px 10px',
              textTransform: 'uppercase',
            }}>
              {current.navLabel}
            </div>
          )}

          <h2 style={{ color: 'var(--text)', fontSize: hasNav ? '1rem' : '1.25rem', fontWeight: 600, marginBottom: 8, margin: '0 0 8px' }}>
            {current.title}
          </h2>

          <p style={{ color: 'var(--text-soft)', fontSize: '0.88rem', lineHeight: 1.65, margin: '0 0 18px' }}>
            {current.body}
          </p>

          {/* Step dots */}
          <div style={{ display: 'flex', gap: 5, marginBottom: 16, justifyContent: hasNav ? 'flex-start' : 'center' }}>
            {STEPS.map((_, i) => (
              <div
                key={i}
                onClick={() => setStep(i)}
                style={{
                  width: i === step ? 18 : 6,
                  height: 6,
                  borderRadius: 3,
                  background: i === step ? 'var(--accent)' : 'var(--border)',
                  cursor: 'pointer',
                  transition: 'width 200ms ease',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexDirection: hasNav ? 'row' : 'column' }}>
            <button
              onClick={handleCta}
              style={{
                flex: hasNav ? 1 : undefined,
                width: hasNav ? undefined : '100%',
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '9px 16px',
                fontSize: '0.88rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {current.cta ?? 'Next →'}
            </button>
            <button
              onClick={handleSkip}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: '0.82rem',
                cursor: 'pointer',
                padding: '4px',
                whiteSpace: 'nowrap',
              }}
            >
              Skip intro
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
