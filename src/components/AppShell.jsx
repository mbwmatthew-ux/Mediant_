import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect, useRef } from 'react'
import styles from './AppShell.module.css'

const NOTIFICATIONS = [
  { id: 1, title: 'Score review ready', body: 'Clair de Lune analysis is complete — 3 issues found.', time: '2m ago', unread: true,  icon: '◫' },
  { id: 2, title: 'Practice streak: 7 days!', body: 'You\'ve practiced every day this week. Keep it up.', time: '1h ago', unread: true,  icon: '🔥' },
  { id: 3, title: 'New feedback available', body: 'Bach Invention No. 8 · Timing in measures 4–6.', time: 'Yesterday', unread: false, icon: '♩' },
  { id: 4, title: 'Session saved', body: 'Gymnopédie No. 1 · 12 min · Score 91/100', time: 'May 13', unread: false, icon: '✓' },
]

const HELP_LINKS = [
  { label: 'How scoring works',       icon: '◎' },
  { label: 'Reading your score sheet', icon: '◫' },
  { label: 'Follow-along guide',      icon: '▶' },
  { label: 'Keyboard shortcuts',      icon: '⌨' },
  { label: 'Contact support',         icon: '✉' },
]

const NAV = [
  { to: '/home',     label: 'Home',            icon: HomeIcon },
  { to: '/search',   label: 'Find Music',       icon: SearchIcon },
  { to: '/record',   label: 'Upload Take',      icon: UploadIcon },
  { to: '/analysis', label: 'Score Review',     icon: ScoreIcon },
  { to: '/follow',   label: 'Follow Along',     icon: PlayIcon },
  { to: '/summary',  label: 'Session Summary',  icon: SummaryIcon },
  { to: '/takes',    label: 'Saved Takes',      icon: SavedIcon },
]

const COACHING_STYLES = ['Constructive and direct', 'Encouraging and gentle', 'Technical and precise']
const DISPLAY_MODES   = ['Playback follow-along', 'Static score review', 'Both']

export default function AppShell() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  const [panel, setPanel] = useState(null)
  const [settingsTab, setSettingsTab] = useState('account')
  const [notifications, setNotifications] = useState(NOTIFICATIONS)
  const [coachingStyle, setCoachingStyle] = useState('Constructive and direct')
  const [displayMode, setDisplayMode]     = useState('Playback follow-along')
  const [bpm, setBpm]                     = useState(60)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const panelRef = useRef(null)

  function handleLogout() {
    logout()
    nav('/')
  }

  function togglePanel(name) {
    setPanel(p => p === name ? null : name)
  }

  function markAllRead() {
    setNotifications(ns => ns.map(n => ({ ...n, unread: false })))
  }

  function saveSettings() {
    setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 2000)
  }

  useEffect(() => {
    function onClickOutside(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setPanel(null)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const initials = user?.name
    ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '?'

  const currentPage = NAV.find(n => n.to === location.pathname)?.label ?? 'Mediant'
  const unreadCount = notifications.filter(n => n.unread).length

  return (
    <div className={styles.shell}>

      {/* Full-width top bar */}
      <header className={styles.topBar}>
        <div className={styles.topBarLeft}>
          <LogoMark />
          <span className={styles.breadcrumbSep}>/</span>
          <span className={styles.breadcrumbOrg}>Mediant</span>
          <span className={styles.breadcrumbSep}>/</span>
          <span className={styles.breadcrumbPage}>{currentPage}</span>
          <span className={styles.envBadge}>PRACTICE</span>
        </div>
        <div className={styles.topBarRight} ref={panelRef}>
          <div className={styles.topBarActions}>

            {/* Notifications */}
            <div className={styles.panelAnchor}>
              <button
                className={`${styles.topBarIconBtn} ${panel === 'notifications' ? styles.topBarIconBtnActive : ''}`}
                onClick={() => togglePanel('notifications')}
                title="Notifications"
              >
                <BellIcon />
                {unreadCount > 0 && <span className={styles.unreadDot} />}
              </button>
              {panel === 'notifications' && (
                <div className={styles.dropdown}>
                  <div className={styles.dropdownHeader}>
                    <span className={styles.dropdownTitle}>Notifications</span>
                    {unreadCount > 0 && (
                      <button className={styles.dropdownAction} onClick={markAllRead}>Mark all read</button>
                    )}
                  </div>
                  <div className={styles.dropdownList}>
                    {notifications.map(n => (
                      <div key={n.id} className={`${styles.notifRow} ${n.unread ? styles.notifUnread : ''}`}>
                        <span className={styles.notifIcon}>{n.icon}</span>
                        <div className={styles.notifBody}>
                          <strong className={styles.notifTitle}>{n.title}</strong>
                          <p className={styles.notifText}>{n.body}</p>
                          <span className={styles.notifTime}>{n.time}</span>
                        </div>
                        {n.unread && <span className={styles.unreadPip} />}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Help */}
            <div className={styles.panelAnchor}>
              <button
                className={`${styles.topBarIconBtn} ${panel === 'help' ? styles.topBarIconBtnActive : ''}`}
                onClick={() => togglePanel('help')}
                title="Help"
              >
                <HelpIcon />
              </button>
              {panel === 'help' && (
                <div className={styles.dropdown}>
                  <div className={styles.dropdownHeader}>
                    <span className={styles.dropdownTitle}>Help & Resources</span>
                  </div>
                  <div className={styles.dropdownList}>
                    {HELP_LINKS.map(({ label, icon }) => (
                      <button key={label} className={styles.helpRow}>
                        <span className={styles.helpIcon}>{icon}</span>
                        <span className={styles.helpLabel}>{label}</span>
                        <span className={styles.helpArrow}>›</span>
                      </button>
                    ))}
                  </div>
                  <div className={styles.dropdownFooter}>
                    Version 0.1 · Mediant
                  </div>
                </div>
              )}
            </div>

            {/* Settings */}
            <div className={styles.panelAnchor}>
              <button
                className={`${styles.topBarIconBtn} ${panel === 'settings' ? styles.topBarIconBtnActive : ''}`}
                onClick={() => togglePanel('settings')}
                title="Settings"
              >
                <SettingsIcon />
              </button>
              {panel === 'settings' && (
                <div className={styles.settingsPanel}>
                  {/* Left nav */}
                  <div className={styles.settingsNav}>
                    <div className={styles.settingsNavUser}>
                      <span className={styles.settingsAvatar}>{initials}</span>
                      <div className={styles.settingsUserInfo}>
                        <strong className={styles.settingsUserName}>{user?.name}</strong>
                        <span className={styles.settingsUserSub}>{user?.email}</span>
                      </div>
                    </div>
                    {[
                      { id: 'account',     label: 'Account',      icon: '◯' },
                      { id: 'preferences', label: 'Preferences',   icon: '⊙' },
                      { id: 'plan',        label: 'Plan & Billing', icon: '◈' },
                    ].map(({ id, label, icon }) => (
                      <button
                        key={id}
                        className={`${styles.settingsNavItem} ${settingsTab === id ? styles.settingsNavItemActive : ''}`}
                        onClick={() => setSettingsTab(id)}
                      >
                        <span className={styles.settingsNavIcon}>{icon}</span>
                        {label}
                      </button>
                    ))}
                    <button className={styles.settingsSignOut} onClick={handleLogout}>Sign out</button>
                  </div>

                  {/* Right content */}
                  <div className={styles.settingsContent}>
                    {settingsTab === 'account' && (
                      <>
                        <p className={styles.settingsSectionTitle}>Account</p>
                        {[
                          { label: 'Name',       value: user?.name },
                          { label: 'Email',      value: user?.email },
                          { label: 'Instrument', value: user?.instrument },
                        ].map(({ label, value }) => (
                          <div key={label} className={styles.settingsRow}>
                            <span className={styles.settingsLabel}>{label}</span>
                            <span className={styles.settingsValue}>{value}</span>
                          </div>
                        ))}
                      </>
                    )}

                    {settingsTab === 'preferences' && (
                      <>
                        <p className={styles.settingsSectionTitle}>Preferences</p>
                        <div className={styles.settingsRow}>
                          <label className={styles.settingsLabel}>Coaching style</label>
                          <select className={styles.settingsSelect} value={coachingStyle} onChange={e => setCoachingStyle(e.target.value)}>
                            {COACHING_STYLES.map(s => <option key={s}>{s}</option>)}
                          </select>
                        </div>
                        <div className={styles.settingsRow}>
                          <label className={styles.settingsLabel}>Score view</label>
                          <select className={styles.settingsSelect} value={displayMode} onChange={e => setDisplayMode(e.target.value)}>
                            {DISPLAY_MODES.map(s => <option key={s}>{s}</option>)}
                          </select>
                        </div>
                        <div className={styles.settingsRow}>
                          <label className={styles.settingsLabel}>Default tempo</label>
                          <div className={styles.settingsBpm}>
                            <button className={styles.bpmBtn} onClick={() => setBpm(b => Math.max(40, b - 5))}>−</button>
                            <span className={styles.bpmVal}>{bpm}</span>
                            <button className={styles.bpmBtn} onClick={() => setBpm(b => Math.min(200, b + 5))}>+</button>
                          </div>
                        </div>
                        <button className={styles.settingsSaveBtn} onClick={saveSettings}>
                          {settingsSaved ? '✓ Saved' : 'Save changes'}
                        </button>
                      </>
                    )}

                    {settingsTab === 'plan' && (
                      <>
                        <p className={styles.settingsSectionTitle}>Plan & Billing</p>
                        <div className={styles.planCard}>
                          <strong className={styles.planName}>Free</strong>
                          <p className={styles.planDesc}>Unlimited sessions · Basic feedback · Community support</p>
                        </div>
                        <div className={styles.planCard} style={{ borderColor: 'rgba(214,177,104,0.35)', background: 'rgba(214,177,104,0.06)' }}>
                          <strong className={styles.planName} style={{ color: 'var(--gold)' }}>Pro — coming soon</strong>
                          <p className={styles.planDesc}>AI-powered coaching · Priority analysis · Export to PDF</p>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {user && (
            <div className={styles.panelAnchor}>
              <button
                className={`${styles.topBarUserChip} ${panel === 'user' ? styles.topBarUserChipActive : ''}`}
                onClick={() => togglePanel('user')}
              >
                <span className={styles.topBarAvatar}>{initials}</span>
                <span className={styles.topBarName}>{user.name}</span>
              </button>
              {panel === 'user' && (
                <div className={styles.dropdown} style={{ minWidth: 200 }}>
                  <div className={styles.dropdownHeader} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                    <span className={styles.dropdownTitle}>{user.name}</span>
                    <span className={styles.dropdownSub}>{user.email}</span>
                  </div>
                  <div className={styles.dropdownList}>
                    <button className={styles.helpRow} onClick={() => { setPanel(null); togglePanel('settings') }}>
                      <span className={styles.helpIcon}>◯</span>
                      <span className={styles.helpLabel}>Account settings</span>
                      <span className={styles.helpArrow}>›</span>
                    </button>
                    <button className={styles.helpRow} style={{ color: 'rgba(225,134,118,0.85)' }} onClick={handleLogout}>
                      <span className={styles.helpIcon}>↩</span>
                      <span className={styles.helpLabel}>Sign out</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Sidebar + content */}
      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <nav className={styles.nav}>
            {NAV.map(({ to, label, icon: Icon }) => (
              <div key={to} className={styles.navItem}>
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                  }
                >
                  <Icon />
                </NavLink>
                <span className={styles.tooltip}>{label}</span>
              </div>
            ))}
          </nav>

          <div className={styles.bottom}>
            {user && (
              <div className={styles.userItem}>
                <button className={styles.userBtn} onClick={handleLogout} title="Sign out">
                  <span className={styles.userAvatar}>{initials}</span>
                </button>
                <span className={styles.tooltip}>Sign out ({user.name})</span>
              </div>
            )}
          </div>
        </aside>

        <main className={styles.main}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function LogoMark() {
  const S = 4.5
  const C = 'rgba(255,255,255,0.92)'
  const top = 14, bot = 72
  const xL = 14, xC = 42, xR = 70

  return (
    <svg width="26" height="30" viewBox="0 0 84 84" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Top bar — overhangs both sides */}
      <line x1="6"  y1={top} x2="78" y2={top} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      {/* Bottom bar — overhangs both sides */}
      <line x1="6"  y1={bot} x2="78" y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      {/* Three verticals: left, center (shared), right */}
      <line x1={xL} y1={top} x2={xL} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xC} y1={top} x2={xC} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xR} y1={top} x2={xR} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      {/* Left diagonal: outer-left-top → center-bottom */}
      <line x1={xL} y1={top} x2={xC} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      {/* Right diagonal: outer-right-top → center-bottom */}
      <line x1={xR} y1={top} x2={xC} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/>
      <path d="M9 21V12h6v9"/>
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7"/>
      <path d="M21 21l-4.35-4.35"/>
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}

function ScoreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/>
    </svg>
  )
}

function SummaryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="8" y1="13" x2="16" y2="13"/>
      <line x1="8" y1="17" x2="14" y2="17"/>
    </svg>
  )
}

function SavedIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
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

function HelpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
}
