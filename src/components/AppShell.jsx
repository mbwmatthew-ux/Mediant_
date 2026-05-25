import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect, useRef } from 'react'
import TunerModal from './Tuner'
import MetronomeModal from './Metronome'
import ErrorBoundary from './ErrorBoundary'
import styles from './AppShell.module.css'
import { playNav } from '../utils/sounds'

const NOTIFICATIONS = []

const NAV_SECTIONS = [
  {
    key: 'workspace',
    label: 'WORKSPACE',
    items: [
      { to: '/home',     label: 'Dashboard', icon: HomeIcon,     live: true },
      { to: '/record',   label: 'Record',     icon: UploadIcon,   live: true },
      { to: '/search',   label: 'Library',    icon: SearchIcon,   live: true },
      { to: '/takes',    label: 'Sessions',   icon: SavedIcon,    live: true },
      { to: '/progress', label: 'Progress',   icon: ProgressIcon, live: true },
    ],
  },
  {
    key: 'tools',
    label: 'TOOLS',
    items: [
      { action: 'tuner',      label: 'Tuner',      icon: TunerNavIcon,      live: true },
      { action: 'metronome', label: 'Metronome', icon: MetronomeNavIcon, live: true },
      { to: '/coach',    label: 'Discussion', icon: DiscussIcon,  live: true },
    ],
  },
  {
    key: 'system',
    label: 'SYSTEM',
    items: [
      { to: '/settings', label: 'Settings', icon: SettingsIcon, live: true },
    ],
  },
]

export default function AppShell() {
  const { user, subscription } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  const [panel, setPanel]                 = useState(null)
  const [notifications, setNotifications] = useState(NOTIFICATIONS)
  const [showTuner,      setShowTuner]    = useState(false)
  const [showMetronome,  setShowMetronome]= useState(false)
  const notifRef = useRef(null)

  function markAllRead() {
    setNotifications(ns => ns.map(n => ({ ...n, unread: false })))
  }

  function handleNavAction(action) {
    playNav()
    if (action === 'tuner')    setShowTuner(true)
    if (action === 'metronome') setShowMetronome(true)
  }

  useEffect(() => {
    function onClickOutside(e) {
      if (notifRef.current && !notifRef.current.contains(e.target)) {
        if (panel === 'notifications') setPanel(null)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [panel])

  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
      if (e.key === 'Escape') setPanel(null)
      if (e.key === 'r' || e.key === 'R') nav('/record')
      if (e.key === 's' || e.key === 'S') nav('/takes')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [nav])

  const initials = user?.name
    ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '?'

  const unreadCount = notifications.filter(n => n.unread).length

  return (
    <div className={styles.shell}>

      {/* Tuner modal */}
      {showTuner && <TunerModal onClose={() => setShowTuner(false)} />}

      {/* Metronome modal */}
      {showMetronome && <MetronomeModal onClose={() => setShowMetronome(false)} />}

      {/* Top bar */}
      <header className={styles.topBar}>
        <div className={styles.topBarLeft}>
          <NavLink to="/home" onClick={playNav} style={{ display: 'flex', alignItems: 'center' }}>
            <LogoMark />
          </NavLink>
        </div>

        <div className={styles.topBarRight} ref={notifRef}>
          <div className={styles.panelAnchor}>
            <button
              className={`${styles.topBarIconBtn} ${panel === 'notifications' ? styles.topBarIconBtnActive : ''}`}
              onClick={() => setPanel(p => p === 'notifications' ? null : 'notifications')}
              title="Notifications"
            >
              <BellIcon />
              {unreadCount > 0 && <span className={styles.unreadDot} />}
            </button>
            {panel === 'notifications' && (
              <div className={styles.dropdown}>
                <div className={styles.dropdownHeader}>
                  <div>
                    <span className={styles.dropdownTitle}>Notifications</span>
                    {unreadCount > 0 && <span className={styles.dropdownSub}>{unreadCount} unread</span>}
                  </div>
                  {unreadCount > 0 && (
                    <button className={styles.dropdownAction} onClick={markAllRead}>Mark all read</button>
                  )}
                </div>
                <div className={styles.dropdownList}>
                  {notifications.length === 0 ? (
                    <div className={styles.dropdownFooter} style={{ padding: '20px 16px', textAlign: 'center' }}>
                      No notifications yet
                    </div>
                  ) : (
                    notifications.map(n => (
                      <div key={n.id} className={`${styles.notifRow} ${n.unread ? styles.notifUnread : ''}`}>
                        <span className={styles.notifIcon}>{n.icon}</span>
                        <div className={styles.notifBody}>
                          <strong className={styles.notifTitle}>{n.title}</strong>
                          <p className={styles.notifText}>{n.body}</p>
                          <span className={styles.notifTime}>{n.time}</span>
                        </div>
                        {n.unread && <span className={styles.unreadPip} />}
                      </div>
                    ))
                  )}
                </div>
                {notifications.length > 0 && (
                  <div className={styles.dropdownFooter}>Only showing the last 30 days</div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Sidebar + content */}
      <div className={styles.body}>
        <aside className={styles.sidebar}>
          {/* User profile */}
          <button
            className={styles.sidebarUser}
            onClick={() => { playNav(); nav('/settings') }}
          >
            <div className={styles.sidebarAvatar}>{initials}</div>
            <div className={styles.sidebarUserInfo}>
              <span className={styles.sidebarUserName}>{user?.name?.split(' ')[0] ?? 'Guest'}</span>
              <span className={styles.sidebarUserLevel}>
                {user?.instrument ? user.instrument.toUpperCase() : subscription?.plan ? subscription.plan.toUpperCase() : 'FREE'}
              </span>
            </div>
          </button>

          {/* Nav sections */}
          <nav className={styles.nav}>
            {NAV_SECTIONS.map(section => (
              <div key={section.key} className={styles.navSection}>
                <span className={styles.navSectionLabel}>{section.label}</span>
                {section.items.map(item => {
                  if (item.action) {
                    return (
                      <button
                        key={item.label}
                        className={styles.navLinkBtn}
                        onClick={() => handleNavAction(item.action)}
                        data-onboarding-label={item.label}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </button>
                    )
                  }
                  return (
                    <NavLink
                      key={item.label}
                      to={item.to}
                      onClick={playNav}
                      className={({ isActive }) =>
                        `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                      }
                      data-onboarding-label={item.label}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </NavLink>
                  )
                })}
              </div>
            ))}
          </nav>
        </aside>

        <main className={styles.main}>
          <ErrorBoundary key={location.pathname}>
            <div key={location.pathname} className={styles.pageIn}>
              <Outlet />
            </div>
          </ErrorBoundary>
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className={styles.mobileNav}>
        {[
          { to: '/home',     label: 'Home',     icon: HomeIcon     },
          { to: '/search',   label: 'Library',  icon: SearchIcon   },
          { to: '/record',   label: 'Record',   icon: UploadIcon   },
          { to: '/progress', label: 'Progress', icon: ProgressIcon },
          { to: '/coach',    label: 'Coach',    icon: CoachIcon    },
        ].map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={playNav}
            className={({ isActive }) =>
              `${styles.mobileNavItem} ${isActive ? styles.mobileNavItemActive : ''}`
            }
          >
            <Icon />
            <span className={styles.mobileNavLabel}>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

/* ── Icons ─────────────────────────────────────────────────── */

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7"/>
    </svg>
  )
}

function LogoMark() {
  return (
    <div style={{
      width: 46, height: 46, flexShrink: 0,
      background: 'white',
      WebkitMask: `url('/logo-mark.png') center/contain no-repeat`,
      WebkitMaskMode: 'luminance',
      mask: `url('/logo-mark.png') center/contain no-repeat`,
      maskMode: 'luminance',
      transition: 'opacity 150ms ease',
      cursor: 'pointer',
    }} />
  )
}

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/>
      <path d="M9 21V12h6v9"/>
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7"/>
      <path d="M21 21l-4.35-4.35"/>
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <line x1="12" y1="8" x2="12" y2="16"/>
      <line x1="8" y1="12" x2="16" y2="12"/>
    </svg>
  )
}

function OtherIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  )
}

function LessonsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
    </svg>
  )
}

function ProgressIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6"  y1="20" x2="6"  y2="14"/>
    </svg>
  )
}


function TunerNavIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 8v4l3 3"/>
    </svg>
  )
}

function MetronomeNavIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 20 22 4 22"/>
      <line x1="12" y1="2" x2="12" y2="22"/>
      <line x1="8" y1="13" x2="16" y2="13"/>
    </svg>
  )
}


function DiscussIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  )
}

function SavedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
    </svg>
  )
}


function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}

function CoachIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  )
}
