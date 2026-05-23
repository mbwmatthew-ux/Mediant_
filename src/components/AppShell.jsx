import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect, useRef } from 'react'
import TunerModal from './Tuner'
import styles from './AppShell.module.css'

const NOTIFICATIONS = []

const NAV_SECTIONS = [
  {
    key: 'workspace',
    label: 'WORKSPACE',
    items: [
      { to: '/home',     label: 'Dashboard',        icon: HomeIcon,     live: true  },
      { to: '/record',   label: 'Record',            icon: UploadIcon,   live: true  },
      { to: '/search',   label: 'Library',           icon: SearchIcon,   live: true  },
      { to: '/takes',    label: 'Sessions',          icon: SavedIcon,    live: true  },
      { to: '/progress', label: 'Progress',          icon: ProgressIcon, live: true  },
      { to: null,        label: 'Other instruments', icon: OtherIcon,    live: false },
      { to: null,        label: 'Lessons',           icon: LessonsIcon,  live: false },
    ],
  },
  {
    key: 'tools',
    label: 'PRACTICE TOOLS',
    items: [
      { to: null,          label: 'Soundcheck',    icon: SoundcheckIcon,  live: false },
      { to: null,          label: 'Metronome',     icon: MetronomeIcon,   live: false },
      { action: 'tuner',   label: 'Tuner',         icon: TunerNavIcon,    live: true  },
      { to: null,          label: 'Duet',          icon: DuetIcon,        live: false },
      { to: null,          label: 'Mock audition', icon: MicIcon,         live: false },
      { to: '/coach',      label: 'Discussion',    icon: DiscussIcon,     live: true  },
    ],
  },
  {
    key: 'system',
    label: 'SYSTEM',
    items: [
      { action: 'account', label: 'Settings', icon: SettingsIcon, live: true },
    ],
  },
]

export default function AppShell() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const [panel, setPanel]                   = useState(null)
  const [notifications, setNotifications]   = useState(NOTIFICATIONS)
  const [expanded, setExpanded]             = useState(null)
  const [editName, setEditName]             = useState(user?.name ?? '')
  const [editInstrument, setEditInstrument] = useState(user?.instrument ?? 'Piano')
  const [showTuner, setShowTuner]           = useState(false)
  const notifRef = useRef(null)

  function handleLogout() {
    logout()
    nav('/')
  }

  function markAllRead() {
    setNotifications(ns => ns.map(n => ({ ...n, unread: false })))
  }

  function toggle(key) {
    setExpanded(e => e === key ? null : key)
  }

  function handleNavAction(action) {
    if (action === 'tuner') setShowTuner(true)
    if (action === 'account') setPanel(p => p === 'account' ? null : 'account')
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
      if (e.key === 'Escape') setPanel(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const initials = user?.name
    ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '?'

  const unreadCount = notifications.filter(n => n.unread).length

  return (
    <div className={styles.shell}>

      {/* Full-screen account overlay */}
      {panel === 'account' && (
        <div className={styles.accountOverlay}>
          <div className={styles.accountHeader}>
            <button className={styles.accountBackBtn} onClick={() => setPanel(null)}>
              <BackIcon /> Back
            </button>
          </div>

          <div className={styles.accountBody}>
            <div className={styles.acctProfile}>
              <div className={styles.acctAvatar}>{initials}</div>
              <div>
                <strong className={styles.acctName}>{user?.name ?? 'Guest'}</strong>
                <span className={styles.acctEmail}>{user?.email}</span>
                <span className={styles.acctPlanBadge}>Free plan</span>
              </div>
            </div>

            <div className={styles.acctSection}>
              <p className={styles.acctSectionTitle}>Your account</p>
              <div className={styles.acctMenuList}>
                <button className={styles.acctRow} onClick={() => toggle('profile')}>
                  <span className={`${styles.acctRowIcon} ${styles.iconGold}`}>◯</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>Edit profile</span>
                    <span className={styles.acctRowSub}>{user?.name} · {user?.instrument ?? 'No instrument set'}</span>
                  </div>
                  <span className={styles.acctRowChevron}>{expanded === 'profile' ? '∨' : '›'}</span>
                </button>
                {expanded === 'profile' && (
                  <div className={styles.acctExpanded}>
                    <div className={styles.acctExpandRow}>
                      <label className={styles.acctExpandLabel}>Name</label>
                      <input
                        className={styles.acctExpandInput}
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        placeholder="Your name"
                      />
                    </div>
                    <div className={styles.acctExpandRow}>
                      <label className={styles.acctExpandLabel}>Instrument</label>
                      <select className={styles.acctPrefSelect} value={editInstrument} onChange={e => setEditInstrument(e.target.value)}>
                        {['Piano','Violin','Cello','Viola','Guitar','Flute','Clarinet','Trumpet','Saxophone','Oboe','Horn','Harp','Other'].map(i => <option key={i}>{i}</option>)}
                      </select>
                    </div>
                    <button className={styles.acctSaveBtn} onClick={() => toggle('profile')}>Save profile</button>
                  </div>
                )}

                <button className={styles.acctRow} onClick={() => toggle('plan')}>
                  <span className={`${styles.acctRowIcon} ${styles.iconGold}`}>◈</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>Plan & billing</span>
                    <span className={styles.acctRowSub}>Free plan · Upgrade to Pro</span>
                  </div>
                  <span className={styles.acctRowChevron}>{expanded === 'plan' ? '∨' : '›'}</span>
                </button>
                {expanded === 'plan' && (
                  <div className={styles.acctExpanded}>
                    <div className={styles.planCard}>
                      <strong className={styles.planCardName}>Free</strong>
                      <p className={styles.planCardDesc}>Unlimited uploads · Performance feedback · Community support</p>
                    </div>
                    <div className={`${styles.planCard} ${styles.planCardPro}`}>
                      <strong className={`${styles.planCardName} ${styles.planCardNamePro}`}>Pro — coming soon</strong>
                      <p className={styles.planCardDesc}>Priority analysis · PDF export · Advanced history · Early access features</p>
                    </div>
                  </div>
                )}

                <button className={styles.acctRow} onClick={() => toggle('privacy')}>
                  <span className={`${styles.acctRowIcon} ${styles.iconGreen}`}>⊙</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>Privacy & data</span>
                    <span className={styles.acctRowSub}>Manage your practice data</span>
                  </div>
                  <span className={styles.acctRowChevron}>{expanded === 'privacy' ? '∨' : '›'}</span>
                </button>
                {expanded === 'privacy' && (
                  <div className={styles.acctExpanded}>
                    <p className={styles.acctExpandBody}>Your recordings and analysis results are stored locally in your browser and are never shared with third parties. Analysis is processed securely and is subject to our privacy policy.</p>
                    <button className={styles.acctDangerBtn} onClick={() => { localStorage.clear(); setPanel(null) }}>
                      Clear all local data
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className={styles.acctSection}>
              <p className={styles.acctSectionTitle}>Help & resources</p>
              <div className={styles.acctMenuList}>
                <button className={styles.acctRow} onClick={() => toggle('scoring')}>
                  <span className={`${styles.acctRowIcon} ${styles.iconMuted}`}>◎</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>How scoring works</span>
                    <span className={styles.acctRowSub}>Learn how Mediant grades your performance</span>
                  </div>
                  <span className={styles.acctRowChevron}>{expanded === 'scoring' ? '∨' : '›'}</span>
                </button>
                {expanded === 'scoring' && (
                  <div className={styles.acctExpanded}>
                    <p className={styles.acctExpandBody}>Mediant scores your performance from 0–100 based on timing accuracy, dynamic control, articulation, and intonation. Each flagged measure reduces the score slightly. Scores above 88 are marked green, 74–87 gold, and below 74 coral. Practice specific flagged sections to improve your score over time.</p>
                  </div>
                )}

                <button className={styles.acctRow} onClick={() => toggle('shortcuts')}>
                  <span className={`${styles.acctRowIcon} ${styles.iconMuted}`}>⌨</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>Keyboard shortcuts</span>
                    <span className={styles.acctRowSub}>Speed up your workflow</span>
                  </div>
                  <span className={styles.acctRowChevron}>{expanded === 'shortcuts' ? '∨' : '›'}</span>
                </button>
                {expanded === 'shortcuts' && (
                  <div className={styles.acctExpanded}>
                    {[
                      ['Space', 'Play / pause'],
                      ['← →', 'Previous / next measure'],
                      ['L', 'Toggle loop on current section'],
                      ['Esc', 'Close any panel'],
                      ['R', 'Go to upload recording'],
                      ['S', 'Go to score review'],
                    ].map(([key, desc]) => (
                      <div key={key} className={styles.shortcutRow}>
                        <kbd className={styles.shortcutKey}>{key}</kbd>
                        <span className={styles.shortcutDesc}>{desc}</span>
                      </div>
                    ))}
                  </div>
                )}

                <a className={styles.acctRow} href="mailto:support@mediant.app">
                  <span className={`${styles.acctRowIcon} ${styles.iconMuted}`}>✉</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>Contact support</span>
                    <span className={styles.acctRowSub}>support@mediant.app</span>
                  </div>
                  <span className={styles.acctRowChevron}>›</span>
                </a>
              </div>
            </div>

            <div className={styles.acctSection}>
              <p className={styles.acctSectionTitle}>About</p>
              <div className={styles.acctMenuList}>
                <div className={styles.acctRow} style={{ cursor: 'default' }}>
                  <span className={`${styles.acctRowIcon} ${styles.iconMuted}`}>ℹ</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>Mediant</span>
                    <span className={styles.acctRowSub}>Version 0.1 · Intelligent music coaching</span>
                  </div>
                </div>
              </div>
            </div>

            <button className={styles.acctSignOutBtn} onClick={handleLogout}>
              <span>↩</span> Sign out
            </button>
          </div>
        </div>
      )}

      {/* Tuner modal */}
      {showTuner && <TunerModal onClose={() => setShowTuner(false)} />}

      {/* Top bar */}
      <header className={styles.topBar}>
        <div className={styles.topBarLeft}>
          <LogoMark />
          <span className={styles.topBarBrand}>Mediant</span>
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
            onClick={() => setPanel(p => p === 'account' ? null : 'account')}
          >
            <div className={styles.sidebarAvatar}>{initials}</div>
            <div className={styles.sidebarUserInfo}>
              <span className={styles.sidebarUserName}>{user?.name?.split(' ')[0] ?? 'Guest'}</span>
              <span className={styles.sidebarUserLevel}>INTERMEDIATE</span>
            </div>
          </button>

          {/* Nav sections */}
          <nav className={styles.nav}>
            {NAV_SECTIONS.map(section => (
              <div key={section.key} className={styles.navSection}>
                <span className={styles.navSectionLabel}>{section.label}</span>
                {section.items.map(item => {
                  if (!item.live) {
                    return (
                      <span key={item.label} className={styles.navLinkStub}>
                        <item.icon />
                        <span>{item.label}</span>
                      </span>
                    )
                  }
                  if (item.action) {
                    return (
                      <button
                        key={item.label}
                        className={styles.navLinkBtn}
                        onClick={() => handleNavAction(item.action)}
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
                      className={({ isActive }) =>
                        `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                      }
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
          <Outlet />
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
  const S = 4.5
  const C = 'rgba(255,255,255,0.92)'
  const top = 14, bot = 72
  const xL = 14, xC = 42, xR = 70
  return (
    <svg width="22" height="26" viewBox="0 0 84 84" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="6"  y1={top} x2="78" y2={top} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1="6"  y1={bot} x2="78" y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xL} y1={top} x2={xL} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xC} y1={top} x2={xC} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xR} y1={top} x2={xR} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xL} y1={top} x2={xC} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
      <line x1={xR} y1={top} x2={xC} y2={bot} stroke={C} strokeWidth={S} strokeLinecap="square"/>
    </svg>
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

function SoundcheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    </svg>
  )
}

function MetronomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L4 20h16L12 2z"/>
      <line x1="12" y1="12" x2="16" y2="8"/>
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

function DuetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8"  y1="23" x2="16" y2="23"/>
    </svg>
  )
}

function MasterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
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
