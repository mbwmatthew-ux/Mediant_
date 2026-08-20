import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect, useRef } from 'react'
import { useRecordModal } from '../context/RecordModalContext'
import NewRecordingModal from './NewRecordingModal'
import NotificationsPopup from './NotificationsPopup'
import LogoMark from './LogoMark'
import ErrorBoundary from './ErrorBoundary'
import styles from './AppShell.module.css'
import { playNav } from '../utils/sounds'
import { supabase } from '../lib/supabase'
import { INSTRUMENTS } from '../lib/instruments'

const NAV_ITEMS = [
  { to: '/home',     label: 'Overview',  icon: HomeIcon     },
  { to: '/analysis', label: 'Analysis',  icon: AnalysisIcon },
  { to: '/sessions', label: 'Sessions',  icon: SessionsIcon },
  { to: '/reports',  label: 'Reports',   icon: ReportsIcon  },
]

/* The 2026-08-20 Home design names five destinations. Library and Insights have
   no page of their own yet, so they point at the nearest existing one rather
   than being dead links. */
const HOME_NAV_ITEMS = [
  { to: '/home',     label: 'Home',     icon: HouseIcon    },
  { to: '/sessions', label: 'Sessions', icon: PulseIcon    },
  { to: '/reports',  label: 'Progress', icon: BarsNavIcon  },
  { to: '/sessions', label: 'Library',  icon: LibraryIcon  },
  { to: '/reports',  label: 'Insights', icon: InsightsIcon },
]

/* Icons drawn to match the design's rail: house, pulse, bars, note, bulb. */
const navStroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }
function HouseIcon() {
  return <svg width="19" height="19" viewBox="0 0 24 24" {...navStroke}><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.8V20h13V9.8"/><path d="M9.8 20v-5.4h4.4V20"/></svg>
}
function PulseIcon() {
  return <svg width="19" height="19" viewBox="0 0 24 24" {...navStroke}><path d="M2 12h4l2.5-7 5 14 2.5-7h6"/></svg>
}
function BarsNavIcon() {
  return <svg width="19" height="19" viewBox="0 0 24 24" {...navStroke}><line x1="5" y1="20" x2="5" y2="13"/><line x1="10" y1="20" x2="10" y2="8"/><line x1="15" y1="20" x2="15" y2="4"/><line x1="20" y1="20" x2="20" y2="11"/></svg>
}
function LibraryIcon() {
  return <svg width="19" height="19" viewBox="0 0 24 24" {...navStroke}><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>
}
function InsightsIcon() {
  return <svg width="19" height="19" viewBox="0 0 24 24" {...navStroke}><path d="M9.5 18h5"/><path d="M10.5 21.5h3"/><path d="M12 2.5a6.5 6.5 0 0 0-3.8 11.8V16h7.6v-1.7A6.5 6.5 0 0 0 12 2.5z"/></svg>
}

function InstrumentModal({ onSave }) {
  const [instrument, setInstrument] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!instrument) return
    setSaving(true)
    await supabase.auth.updateUser({ data: { instrument } })
    onSave(instrument)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.45)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        background: 'var(--bg-card)', borderRadius: 16, padding: '32px 28px',
        maxWidth: 400, width: '100%', boxShadow: 'var(--shadow-lg)',
      }}>
        <p style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--accent)', margin: '0 0 8px' }}>One quick thing</p>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text)', margin: '0 0 8px', letterSpacing: '-0.02em' }}>What instrument do you play?</h2>
        <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: '0 0 24px', lineHeight: 1.55 }}>
          Mediant uses this to tailor feedback — pitch ranges, technique cues, and more.
        </p>
        <select
          value={instrument}
          onChange={e => setInstrument(e.target.value)}
          style={{
            width: '100%', padding: '10px 13px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg)',
            color: instrument ? 'var(--text)' : 'var(--text-muted)',
            fontFamily: 'inherit', fontSize: '0.9rem', marginBottom: 16,
            appearance: 'none', outline: 'none',
          }}
        >
          <option value="">Select an instrument…</option>
          {INSTRUMENTS.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
        <button
          onClick={handleSave}
          disabled={!instrument || saving}
          style={{
            width: '100%', padding: '12px', borderRadius: 9,
            background: instrument ? 'var(--accent)' : 'var(--border)',
            color: '#fff', border: 'none', fontFamily: 'inherit',
            fontSize: '0.92rem', fontWeight: 700, cursor: instrument ? 'pointer' : 'not-allowed',
            transition: 'background 140ms',
          }}
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}

/** Tip-card mascot: the character from the design's sidebar. */
function TipMascot() {
  return (
    <svg viewBox="0 0 104 92" className={styles.tipMascot} aria-hidden="true">
      <defs>
        <radialGradient id="tipBody" cx="44%" cy="26%" r="84%">
          <stop offset="0%" stopColor="#C6F1D9" />
          <stop offset="100%" stopColor="#9FDCBC" />
        </radialGradient>
      </defs>
      <path fill="url(#tipBody)"
            d="M50 8c17 0 27 11 29 27 2 16-2 34-11 42-9 8-27 9-38 3S15 52 17 36C19 20 33 8 50 8Z" />
      <path d="M35 44c3 5 9 5 12 0" fill="none" stroke="#1F4C3E" strokeWidth="4" strokeLinecap="round" />
      <path d="M55 44c3 5 9 5 12 0" fill="none" stroke="#1F4C3E" strokeWidth="4" strokeLinecap="round" />
      <path d="M44 56 H60 A8 8 0 0 1 44 56 Z" fill="#1F4C3E" />
      <ellipse cx="30" cy="54" rx="7" ry="4.5" fill="#F3A9A1" opacity="0.6" />
      <ellipse cx="72" cy="54" rx="7" ry="4.5" fill="#F3A9A1" opacity="0.6" />
      <path fill="#F5C84E" d="M86 16l2.6 6.8L96 26l-7.4 2.7L86 36l-2.6-7.3L76 26l7.4-3.2Z" />
      <path fill="#F5C84E" d="M20 20l1.4 3.7L25 25l-3.6 1.4L20 30l-1.4-3.6L15 25l3.6-1.3Z" opacity="0.75" />
    </svg>
  )
}

export default function AppShell() {
  const { user } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  const { open: showRecord, setOpen: setShowRecord } = useRecordModal()
  const [needsInstrument, setNeedsInstrument] = useState(!user?.instrument)

  // 'r' opens the recording modal
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
      if (e.key === 'r' || e.key === 'R') setShowRecord(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setShowRecord])

  const initials = user?.name
    ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '?'

  const [notifOpen, setNotifOpen] = useState(false)
  const [barVisible, setBarVisible] = useState(true)
  const lastScrollY = useRef(0)
  const mainRef = useRef(null)

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    function onScroll() {
      const y = el.scrollTop
      if (y <= 60) {
        setBarVisible(true)
      } else if (y > lastScrollY.current + 4) {
        setBarVisible(false)
      } else if (y < lastScrollY.current - 4) {
        setBarVisible(true)
      }
      lastScrollY.current = y
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const PAGE_TITLES = {
    '/home': 'Overview', '/analysis': 'Analysis',
    '/sessions': 'Sessions', '/reports': 'Reports', '/settings': 'Settings',
  }
  const pageTitle = PAGE_TITLES[location.pathname] ?? ''

  /* The Home screen runs the 2026-08-20 design: a permanently open 232px rail
     and no top bar. Every other route keeps the 72px hover rail and the bar. */
  const isHome = location.pathname === '/home'

  return (
    <div className={styles.shell}>
      <NewRecordingModal open={showRecord} onClose={() => setShowRecord(false)} />
      {needsInstrument && <InstrumentModal onSave={() => setNeedsInstrument(false)} />}

      <a className={styles.skipLink} href="#main-content">Skip to content</a>

      {/* Mobile top header (logo + account) — hidden on desktop */}
      <header className={`${styles.mobileHeader} ${barVisible ? '' : styles.barHidden}`}>
        <NavLink to="/home" className={styles.mobileHeaderBrand} onClick={playNav} aria-label="Mediant home">
          <LogoMark size={30} />
          <span className={styles.mobileHeaderWordmark}>MEDIANT</span>
        </NavLink>
        <button
          className={styles.mobileHeaderAvatar}
          onClick={() => { playNav(); nav('/settings') }}
          aria-label="Account and settings"
        >
          {initials}
        </button>
      </header>

      <div className={`${styles.body} ${isHome ? styles.bodyHome : ''}`}>
        {/* Sidebar */}
        <aside className={`${styles.sidebar} ${isHome ? styles.sidebarHome : ''}`}>
          {/* Logo */}
          <NavLink to="/home" className={styles.sidebarLogo} onClick={playNav} title="Mediant">
            <LogoMark size={36} />
            <span className={styles.sidebarWordmark}>{isHome ? 'Mediant' : 'MEDIANT'}</span>
          </NavLink>

          {/* Record & Analyze CTA — not part of the Home design's rail */}
          {!isHome && (
            <button
              className={styles.recordCta}
              onClick={() => { playNav(); setShowRecord(true) }}
            >
              <MicIcon /><span className={styles.ctaLabel}>Record &amp; Analyze</span>
            </button>
          )}

          <nav className={styles.nav} aria-label="Primary navigation">
            {(isHome ? HOME_NAV_ITEMS : NAV_ITEMS).map(item => (
              <NavLink
                key={item.label}
                end
                to={item.to}
                onClick={playNav}
                className={({ isActive }) =>
                  `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
                }
                title={item.label}
              >
                <span className={styles.navIcon}><item.icon /></span>
                <span className={styles.navLabel}>{item.label}</span>
              </NavLink>
            ))}
          </nav>

          {isHome && (
            <div className={styles.railFoot}>
              <div className={styles.tipCard}>
                <TipMascot />
                <span className={styles.tipTitle}>Tip of the day</span>
                <p className={styles.tipBody}>Short, focused sessions lead to lasting progress.</p>
                <div className={styles.tipDots} aria-hidden="true">
                  <i className={styles.tipDotOn} /><i /><i />
                </div>
              </div>

              <button className={styles.profileRow} onClick={() => { playNav(); nav('/settings') }}>
                <span className={styles.profileAvatar}>{initials}</span>
                <span className={styles.profileText}>
                  <span className={styles.profileName}>{user?.name || 'Your profile'}</span>
                  <span className={styles.profileLink}>View profile</span>
                </span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 5 16 12 9 19" />
                </svg>
              </button>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main ref={mainRef} className={styles.main} id="main-content">
          {/* Top bar — the Home design has none */}
          {!isHome && (
          <header className={`${styles.topBar} ${barVisible ? '' : styles.barHidden}`}>
            <span className={styles.topBarTitle}>{pageTitle}</span>
            <div className={styles.topBarRight} style={{ position: 'relative' }}>
              <button
                className={`${styles.topBarIconBtn} ${notifOpen ? styles.topBarIconBtnActive : ''}`}
                title="Notifications"
                aria-label="Notifications"
                onClick={() => setNotifOpen(o => !o)}
              >
                <BellIcon />
              </button>
              {notifOpen && <NotificationsPopup onClose={() => setNotifOpen(false)} />}
              <button className={styles.topBarIconBtn} onClick={() => { playNav(); nav('/settings') }} title="Settings" aria-label="Settings">
                <SettingsIcon />
              </button>
              <button className={styles.topBarAvatar} onClick={() => { playNav(); nav('/settings') }} title={user?.name ?? 'Account'} aria-label="Account">
                {initials}
              </button>
            </div>
          </header>
          )}
          <ErrorBoundary key={location.pathname}>
            <div key={location.pathname} className={styles.pageIn}>
              <Outlet />
            </div>
          </ErrorBoundary>
        </main>
      </div>

      {/* Mobile bottom nav — 4 primary destinations */}
      <nav className={styles.mobileNav} aria-label="Primary">
        {NAV_ITEMS.map(item => (
          <NavLink
            key={item.label}
            to={item.to}
            onClick={playNav}
            className={({ isActive }) => `${styles.mobileNavItem} ${isActive ? styles.mobileNavItemActive : ''}`}
          >
            <item.icon />
            <span className={styles.mobileNavLabel}>{item.label}</span>
          </NavLink>
        ))}
        <button
          className={styles.mobileRecord}
          onClick={() => { playNav(); setShowRecord(true) }}
          aria-label="Record a new take"
        >
          <span className={styles.mobileRecordBtn}><MicIcon /></span>
          <span className={styles.mobileRecordLabel}>Record</span>
        </button>
      </nav>
    </div>
  )
}

/* ── Icons ─────────────────────────────────────────────────── */
function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  )
}

function AnalysisIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
    </svg>
  )
}

function SessionsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
  )
}

function ReportsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2"/>
      <path d="M7 14l3-3 2 2 4-4"/>
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
}

function HelpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )
}
