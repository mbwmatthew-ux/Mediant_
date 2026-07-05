import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect } from 'react'
import { useRecordModal } from '../context/RecordModalContext'
import NewRecordingModal from './NewRecordingModal'
import NotificationsPopup from './NotificationsPopup'
import LogoMark from './LogoMark'
import ErrorBoundary from './ErrorBoundary'
import styles from './AppShell.module.css'
import { playNav } from '../utils/sounds'

const NAV_ITEMS = [
  { to: '/home',     label: 'Overview',  icon: HomeIcon     },
  { to: '/analysis', label: 'Analysis',  icon: AnalysisIcon },
  { to: '/sessions', label: 'Sessions',  icon: SessionsIcon },
  { to: '/reports',  label: 'Reports',   icon: ReportsIcon  },
]

export default function AppShell() {
  const { user } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  const { open: showRecord, setOpen: setShowRecord } = useRecordModal()

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

  const PAGE_TITLES = {
    '/home': 'Overview', '/analysis': 'Analysis',
    '/sessions': 'Sessions', '/reports': 'Reports', '/settings': 'Settings',
  }
  const pageTitle = PAGE_TITLES[location.pathname] ?? ''

  return (
    <div className={styles.shell}>
      <NewRecordingModal open={showRecord} onClose={() => setShowRecord(false)} />

      <a className={styles.skipLink} href="#main-content">Skip to content</a>

      {/* Mobile top header (logo + account) — hidden on desktop */}
      <header className={styles.mobileHeader}>
        <NavLink to="/home" className={styles.mobileHeaderBrand} onClick={playNav} aria-label="Mediant home">
          <LogoMark size={26} />
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

      <div className={styles.body}>
        {/* Sidebar */}
        <aside className={styles.sidebar}>
          {/* Logo */}
          <NavLink to="/home" className={styles.sidebarLogo} onClick={playNav} title="Mediant">
            <LogoMark size={26} />
            MEDIANT
          </NavLink>

          {/* Record & Analyze CTA */}
          <button
            className={styles.recordCta}
            onClick={() => { playNav(); setShowRecord(true) }}
          >
            <MicIcon /> Record &amp; Analyze
          </button>

          <nav className={styles.nav} aria-label="Primary navigation">
            {NAV_ITEMS.map(item => (
              <NavLink
                key={item.label}
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

          {/* Bottom: Settings + Help + account */}
          <div className={styles.sidebarBottom}>
            <NavLink
              to="/settings"
              onClick={playNav}
              className={({ isActive }) => `${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
              title="Settings"
            >
              <span className={styles.navIcon}><SettingsIcon /></span>
              <span className={styles.navLabel}>Settings</span>
            </NavLink>
            <span className={`${styles.navItem} ${styles.navItemDisabled}`} title="Help center">
              <span className={styles.navIcon}><HelpIcon /></span>
              <span className={styles.navLabel}>Help center</span>
            </span>

            <button
              className={`${styles.navItem} ${styles.avatarItem}`}
              onClick={() => { playNav(); nav('/settings') }}
              title={user?.name ?? 'Account'}
            >
              <span className={styles.avatarChip}>{initials}</span>
              <span className={styles.navLabel}>{user?.name?.split(' ')[0] ?? 'Account'}</span>
            </button>
          </div>
        </aside>

        {/* Main content */}
        <main className={styles.main} id="main-content">
          {/* Top bar */}
          <header className={styles.topBar}>
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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
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
