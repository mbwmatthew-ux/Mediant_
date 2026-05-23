import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const STEPS = [
  {
    icon: '♩',
    title: 'Welcome to Mediant',
    body: 'Your personal AI music coach. Upload a recording of yourself playing and get measure-level feedback — just like working with a professional teacher.',
  },
  {
    icon: '⌂',
    label: 'Dashboard',
    title: 'Your home base',
    body: 'The Dashboard shows your latest analysis, technique tips from your last session, your practice streak, and a score history at a glance.',
  },
  {
    icon: '⊕',
    label: 'Record',
    title: 'Upload a recording',
    body: 'Drop in your sheet music and a video of yourself playing. Mediant reads the score and listens to your performance, then flags specific measures to work on.',
  },
  {
    icon: '◫',
    label: 'Library',
    title: 'Your music library',
    body: 'Upload and organise your sheet music collection. The AI reads each piece and fills in the key, time signature, composer, and difficulty automatically.',
  },
  {
    icon: '◷',
    label: 'Sessions',
    title: 'All your recordings',
    body: 'Every take you upload is saved here. Tap any session to jump back into the full score review and coaching notes for that recording.',
  },
  {
    icon: '↗',
    label: 'Progress',
    title: 'Track your improvement',
    body: 'See your scores and flags over time. Generate a weekly or monthly AI coaching report that identifies recurring patterns and gives you concrete goals.',
  },
  {
    icon: '◻',
    label: 'Discussion',
    title: 'Ask your coach anything',
    body: 'Chat with your AI coach at any time — ask about technique, theory, practice strategy, or follow up on something flagged in a recent session.',
  },
  {
    icon: '✓',
    title: "You're all set",
    body: 'Start by uploading a recording. You can use a phone video — no fancy equipment needed.',
    cta: 'Upload a recording',
    action: 'record',
  },
]

export default function Onboarding({ onClose }) {
  const nav = useNavigate()
  const [step, setStep] = useState(0)
  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  function handleCta() {
    if (isLast) {
      localStorage.setItem('mediant_onboarded', '1')
      onClose()
      nav('/record')
    } else {
      setStep(s => s + 1)
    }
  }

  function handleSkip() {
    localStorage.setItem('mediant_onboarded', '1')
    onClose()
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(10,12,14,0.82)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px',
      }}
      onClick={e => { if (e.target === e.currentTarget) handleSkip() }}
    >
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 20,
        padding: '40px 36px',
        maxWidth: 440,
        width: '100%',
        textAlign: 'center',
      }}>

        {/* Icon */}
        <div style={{ fontSize: '2rem', marginBottom: current.label ? 10 : 20, color: 'var(--accent)' }}>
          {current.icon}
        </div>

        {/* Tab label badge */}
        {current.label && (
          <div style={{
            display: 'inline-block',
            background: 'rgba(var(--accent-rgb, 88,121,101),0.12)',
            border: '1px solid rgba(var(--accent-rgb, 88,121,101),0.25)',
            borderRadius: 20,
            color: 'var(--accent)',
            fontSize: '0.75rem',
            fontWeight: 600,
            letterSpacing: '0.05em',
            marginBottom: 14,
            padding: '3px 12px',
            textTransform: 'uppercase',
          }}>
            {current.label}
          </div>
        )}

        <h2 style={{ color: 'var(--text)', fontSize: '1.25rem', fontWeight: 600, marginBottom: 10 }}>
          {current.title}
        </h2>

        <p style={{ color: 'var(--text-soft)', fontSize: '0.92rem', lineHeight: 1.65, marginBottom: 28 }}>
          {current.body}
        </p>

        {/* Step dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 5, marginBottom: 24 }}>
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
                transition: 'width 200ms ease, background 200ms ease',
              }}
            />
          ))}
        </div>

        <button
          onClick={handleCta}
          style={{
            width: '100%',
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            padding: '13px 20px',
            fontSize: '0.95rem',
            fontWeight: 600,
            cursor: 'pointer',
            marginBottom: 12,
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
            fontSize: '0.85rem',
            cursor: 'pointer',
            padding: '4px 8px',
          }}
        >
          Skip intro
        </button>
      </div>
    </div>
  )
}
