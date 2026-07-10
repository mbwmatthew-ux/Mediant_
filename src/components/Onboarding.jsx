import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const STEPS = [
  {
    icon: '♩',
    title: 'Welcome to Mediant',
    body: 'Your personal music performance coach. Upload a recording of yourself playing and get measure-level feedback — just like working with a professional teacher.',
  },
  {
    navLabel: 'Home',
    title: 'Your home base',
    body: 'See your latest analysis, technique tips from your most recent session, your practice streak, and your score history at a glance.',
  },
  {
    navLabel: 'Music',
    title: 'Your music library',
    body: 'Upload and organise your sheet music collection. Mediant reads each piece and fills in the key, time signature, composer, and difficulty level automatically.',
  },
  {
    navLabel: 'New Session',
    title: 'Upload a recording',
    body: 'Drop in your sheet music and a video of yourself playing. Mediant reads the score, listens to your performance, and flags specific measures to work on.',
  },
  {
    navLabel: 'Reports',
    title: 'Track your improvement',
    body: 'See your scores and flags over time. Generate a weekly or monthly Mediant practice report that identifies recurring patterns and sets concrete goals.',
  },
  {
    navLabel: 'AI Coach',
    title: 'Ask Mediant anything',
    body: 'Chat with Mediant at any time — about technique, theory, practice strategy, or anything flagged in a recent session.',
  },
  {
    navLabel: 'Analysis',
    title: 'All your recordings',
    body: 'Every take you upload is saved here. Tap any session to jump straight back into the full score review and coaching notes.',
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
  return document.querySelector(`[data-onboarding-label="${label}"]`) ?? null
}

export default function Onboarding({ onClose }) {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState(null)
  const [isPhone, setIsPhone] = useState(
    typeof window !== 'undefined' && window.innerWidth <= 700,
  )
  const current = STEPS[step]
  const isLast = step === STEPS.length - 1
  const hasNav = !!current.navLabel

  // Track viewport so the card can re-flow on small screens / rotation
  useEffect(() => {
    function onResize() { setIsPhone(window.innerWidth <= 700) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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

  // Card position: centred in the main content area, vertically on the nav item
  const CARD_W    = 300
  const CARD_H    = 240
  const TOP_BAR_H = 52
  const BOTTOM_NAV_H = 64   // fixed mobile bottom nav

  const cardStyle = isPhone
    // ── Phone: fluid, centred, kept clear of the fixed top header + bottom nav.
    //    The spotlight ring still highlights the (bottom-nav) target separately.
    ? {
        position: 'fixed',
        left: '50%',
        top: hasNav && rect
          ? `${TOP_BAR_H + 12}px`
          : '50%',
        transform: hasNav && rect
          ? 'translateX(-50%)'
          : 'translate(-50%, -50%)',
        maxHeight: `calc(100dvh - ${TOP_BAR_H + BOTTOM_NAV_H + 32}px)`,
        overflowY: 'auto',
        width: 'min(420px, calc(100vw - 32px))',
        zIndex: 1002,
      }
    : rect ? {
        position: 'fixed',
        left: Math.min(rect.right + 18, window.innerWidth - CARD_W - 12),
        top: Math.min(
          Math.max(TOP_BAR_H + 8, rect.top + rect.height / 2 - CARD_H / 2),
          window.innerHeight - CARD_H - 12,
        ),
        width: CARD_W,
        zIndex: 1002,
      } : {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 420,
        zIndex: 1002,
      }

  return createPortal(
    <>
      {/* inject pulse keyframe once */}
      <style>{`@keyframes ob-pulse{0%,100%{box-shadow:0 0 0 9999px rgba(10,12,14,.82),0 0 0 3px var(--accent)}50%{box-shadow:0 0 0 9999px rgba(10,12,14,.82),0 0 0 5px var(--accent),0 0 16px 4px rgba(44,103,75,.45)}}`}</style>

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

      {/* Arrow pointing to the side nav item (desktop only — the bottom
          nav on phones sits below, so the side arrow would point at nothing) */}
      {hasNav && rect && !isPhone && (
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
              background: 'rgba(44,103,75,.14)',
              border: '1px solid rgba(44,103,75,.28)',
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

          <h2 style={{ color: 'var(--text)', fontSize: hasNav ? (isPhone ? '1.1rem' : '1rem') : '1.25rem', fontWeight: 600, marginBottom: 8, margin: '0 0 8px' }}>
            {current.title}
          </h2>

          <p style={{ color: 'var(--text-soft)', fontSize: isPhone ? '0.95rem' : '0.88rem', lineHeight: 1.65, margin: '0 0 18px' }}>
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
                minHeight: isPhone ? 44 : undefined,
                background: 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '9px 16px',
                fontSize: isPhone ? '0.95rem' : '0.88rem',
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
                fontSize: isPhone ? '0.9rem' : '0.82rem',
                cursor: 'pointer',
                minHeight: isPhone ? 44 : undefined,
                padding: isPhone ? '4px 12px' : '4px',
                whiteSpace: 'nowrap',
              }}
            >
              Skip intro
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}
