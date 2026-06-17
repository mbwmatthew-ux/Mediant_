import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect } from 'react'
import TunerModal from './Tuner'
import MetronomeModal from './Metronome'
import ErrorBoundary from './ErrorBoundary'
import LogoMark from './LogoMark'
import styles from './AppShell.module.css'
import { playNav } from '../utils/sounds'

const NAV_ITEMS = [
  { to: '/home',     label: 'Home',       icon: HomeIcon     },
  { to: '/takes',    label: 'Library',    icon: LibraryIcon  },
  { to: '/record',   label: 'New Take',   icon: RecordIcon   },
  { to: '/progress', label: 'Progress',   icon: ProgressIcon },
  { to: '/settings', label: 'Settings',   icon: SettingsIcon },
]

const TOOL_ITEMS = [
  { to: '/coach',        label: 'AI Coach',   icon: CoachIcon    },
  { to: '/analysis',     label: 'Analysis',   icon: AnalysisIcon },
  { action: 'tuner',     label: 'Tuner',     icon: TunerIcon     },
  { action: 'metronome', label: 'Metronome', icon: MetronomeIcon },
]

/* Mobile pop-up menus — small menus opened from the bottom bar (Library) and
   the top bar (Tools). Nothing is removed; these just group secondary destinations. */
const LIBRARY_MENU = {
  title: 'Library',
  items: [
    { to: '/takes',    label: 'My Songs', icon: LibraryIcon  },
    { to: '/analysis', label: 'Analysis', icon: AnalysisIcon },
    { to: '/progress', label: 'Progress', icon: ProgressIcon },
  ],
}
const TOOLS_MENU = {
  title: 'Tools',
  items: [
    { action: 'tuner',     label: 'Tuner',     icon: TunerIcon     },
    { action: 'metronome', label: 'Metronome', icon: MetronomeIcon },
  ],
}
const MENUS = { library: LIBRARY_MENU, tools: TOOLS_MENU }

export default function AppShell() {
  const { user } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  const [showTuner,     setShowTuner]    = useState(false)
  const [showMetronome, setShowMetronome]= useState(false)
  const [menu,          setMenu]         = useState(null) // null | 'library' | 'tools'

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
      if (e.key === 'r' || e.key === 'R') nav('/record')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [nav])

  // Close the mobile pop-up menu on Escape
  useEffect(() => {
    if (!menu) return
    function onKey(e) { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menu])

  const initials = user?.name
    ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '?'

  function handleToolAction(action) {
    playNav()
    setMenu(null)
    if (action === 'tuner')     setShowTuner(true)
    if (action === 'metronome') setShowMetronome(true)
  }

  // The "Library" tab stands in for My Songs, Analysis and Progress
  const libraryActive = menu === 'library' ||
    ['/takes', '/analysis', '/progress'].includes(location.pathname)

  return (
    <div className={styles.shell}>
      {showTuner     && <TunerModal     onClose={() => setShowTuner(false)}     />}
      {showMetronome && <MetronomeModal onClose={() => setShowMetronome(false)} />}

      <a className={styles.skipLink} href="#main-content">Skip to content</a>

      {/* Mobile top header (logo + account) — hidden on desktop */}
      <header className={styles.mobileHeader}>
        <NavLink to="/home" className={styles.mobileHeaderBrand} onClick={playNav} aria-label="Mediant home">
          <span className={styles.mobileHeaderLogo}><LogoMark size={20} color="rgba(255,255,255,0.92)" /></span>
          <span className={styles.mobileHeaderWordmark}>Mediant</span>
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
            <LogoMark size={30} color="rgba(255,255,255,0.9)" />
          </NavLink>

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

            <div className={styles.navDivider} />

            {TOOL_ITEMS.map(item => item.to ? (
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
            ) : (
              <button
                key={item.label}
                className={styles.navItem}
                onClick={() => handleToolAction(item.action)}
                title={item.label}
              >
                <span className={styles.navIcon}><item.icon /></span>
                <span className={styles.navLabel}>{item.label}</span>
              </button>
            ))}
          </nav>

          {/* Account */}
          <div className={styles.sidebarBottom}>
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
          <ErrorBoundary key={location.pathname}>
            <div key={location.pathname} className={styles.pageIn}>
              <Outlet />
            </div>
          </ErrorBoundary>
        </main>
      </div>

      {/* Mobile bottom nav — 4 primary destinations, Record prominent */}
      <nav className={styles.mobileNav} aria-label="Primary">
        <NavLink
          to="/home"
          onClick={playNav}
          className={({ isActive }) => `${styles.mobileNavItem} ${isActive ? styles.mobileNavItemActive : ''}`}
        >
          <HomeIcon />
          <span className={styles.mobileNavLabel}>Home</span>
        </NavLink>

        <button
          className={`${styles.mobileNavItem} ${libraryActive ? styles.mobileNavItemActive : ''}`}
          onClick={() => { playNav(); setMenu(m => m === 'library' ? null : 'library') }}
          aria-haspopup="dialog"
          aria-expanded={menu === 'library'}
        >
          <LibraryIcon />
          <span className={styles.mobileNavLabel}>Library</span>
        </button>

        <NavLink
          to="/record"
          onClick={playNav}
          className={({ isActive }) => `${styles.mobileRecord} ${isActive ? styles.mobileRecordActive : ''}`}
          aria-label="Record a new take"
        >
          <span className={styles.mobileRecordBtn}><RecordIcon /></span>
          <span className={styles.mobileRecordLabel}>Record</span>
        </NavLink>

        <button
          className={`${styles.mobileNavItem} ${menu === 'tools' ? styles.mobileNavItemActive : ''}`}
          onClick={() => { playNav(); setMenu(m => m === 'tools' ? null : 'tools') }}
          aria-haspopup="dialog"
          aria-expanded={menu === 'tools'}
        >
          <ToolsIcon />
          <span className={styles.mobileNavLabel}>Tools</span>
        </button>

        <NavLink
          to="/coach"
          onClick={playNav}
          className={({ isActive }) => `${styles.mobileNavItem} ${isActive ? styles.mobileNavItemActive : ''}`}
        >
          <CoachIcon />
          <span className={styles.mobileNavLabel}>Coach</span>
        </NavLink>
      </nav>

      {/* Mobile pop-up menu (Library / Tools) */}
      {menu && (
        <div className={styles.menuOverlay} role="dialog" aria-modal="true" aria-label={`${MENUS[menu].title} menu`}>
          <button className={styles.menuBackdrop} onClick={() => setMenu(null)} aria-label="Close menu" />
          <div className={styles.menuSheet}>
            <div className={styles.menuHandle} />
            <p className={styles.menuTitle}>{MENUS[menu].title}</p>
            <div className={styles.menuList}>
              {MENUS[menu].items.map(item => item.to ? (
                <NavLink
                  key={item.label}
                  to={item.to}
                  onClick={() => { playNav(); setMenu(null) }}
                  className={({ isActive }) => `${styles.menuItem} ${isActive ? styles.menuItemActive : ''}`}
                >
                  <span className={styles.menuItemIcon}><item.icon /></span>
                  <span className={styles.menuItemLabel}>{item.label}</span>
                  <ChevronIcon />
                </NavLink>
              ) : (
                <button
                  key={item.label}
                  className={styles.menuItem}
                  onClick={() => handleToolAction(item.action)}
                >
                  <span className={styles.menuItemIcon}><item.icon /></span>
                  <span className={styles.menuItemLabel}>{item.label}</span>
                  <ChevronIcon />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Icons ─────────────────────────────────────────────────── */

function HomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/>
      <path d="M9 21V12h6v9"/>
    </svg>
  )
}

function LibraryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
    </svg>
  )
}

function RecordIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <line x1="12" y1="8" x2="12" y2="16"/>
      <line x1="8" y1="12" x2="16" y2="12"/>
    </svg>
  )
}

function AnalysisIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2"/>
      <path d="M7 9h10M7 13h6M7 17h4"/>
    </svg>
  )
}

function ProgressIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6"  y1="20" x2="6"  y2="14"/>
    </svg>
  )
}

function CoachIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  )
}

function TunerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 8v4l3 3"/>
    </svg>
  )
}

function MetronomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 20 22 4 22"/>
      <line x1="12" y1="2" x2="12" y2="22"/>
      <line x1="8" y1="13" x2="16" y2="13"/>
    </svg>
  )
}

function ToolsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
      <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
      <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6"/>
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
