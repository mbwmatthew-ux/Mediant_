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


const NAV = [
  { to: '/home',     label: 'Home',            icon: HomeIcon },
  { to: '/search',   label: 'Find Music',       icon: SearchIcon },
  { to: '/record',   label: 'Upload Take',      icon: UploadIcon },
  { to: '/analysis', label: 'Score Review',     icon: ScoreIcon },
  { to: '/follow',   label: 'Follow Along',     icon: PlayIcon },
  { to: '/summary',  label: 'Session Summary',  icon: SummaryIcon },
  { to: '/takes',    label: 'Saved Takes',      icon: SavedIcon },
]


export default function AppShell() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const location = useLocation()
  const [panel, setPanel]                 = useState(null)
  const [notifications, setNotifications] = useState(NOTIFICATIONS)
  const [expanded, setExpanded]           = useState(null)
  const [editName, setEditName]           = useState(user?.name ?? '')
  const [editInstrument, setEditInstrument] = useState(user?.instrument ?? 'Piano')
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

  // Close notification dropdown on outside click
  useEffect(() => {
    function onClickOutside(e) {
      if (notifRef.current && !notifRef.current.contains(e.target)) {
        if (panel === 'notifications') setPanel(null)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [panel])

  // Close overlays on Escape
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

  const currentPage = NAV.find(n => n.to === location.pathname)?.label ?? 'Mediant'
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
            {/* Profile card */}
            <div className={styles.acctProfile}>
              <div className={styles.acctAvatar}>{initials}</div>
              <div>
                <strong className={styles.acctName}>{user?.name ?? 'Guest'}</strong>
                <span className={styles.acctEmail}>{user?.email}</span>
                <span className={styles.acctPlanBadge}>Free plan</span>
              </div>
            </div>

            {/* Your account */}
            <div className={styles.acctSection}>
              <p className={styles.acctSectionTitle}>Your account</p>
              <div className={styles.acctMenuList}>

                {/* Edit profile */}
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

                {/* Plan & billing */}
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
                      <p className={styles.planCardDesc}>Unlimited uploads · AI performance feedback · Community support</p>
                    </div>
                    <div className={`${styles.planCard} ${styles.planCardPro}`}>
                      <strong className={`${styles.planCardName} ${styles.planCardNamePro}`}>Pro — coming soon</strong>
                      <p className={styles.planCardDesc}>Priority AI analysis · PDF export · Advanced history · Early access features</p>
                    </div>
                  </div>
                )}

                {/* Privacy & data */}
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
                    <p className={styles.acctExpandBody}>Your recordings and analysis results are stored locally in your browser and are never shared with third parties. AI analysis calls are processed by Anthropic and are subject to their privacy policy.</p>
                    <button className={styles.acctDangerBtn} onClick={() => { localStorage.clear(); setPanel(null) }}>
                      Clear all local data
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Help & resources */}
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

                <button
                  className={styles.acctRow}
                  onClick={() => { setPanel(null); nav('/follow') }}
                >
                  <span className={`${styles.acctRowIcon} ${styles.iconMuted}`}>▶</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>Follow-along guide</span>
                    <span className={styles.acctRowSub}>Open the practice loop feature</span>
                  </div>
                  <span className={styles.acctRowChevron}>›</span>
                </button>

                <a
                  className={styles.acctRow}
                  href="mailto:support@mediant.app"
                >
                  <span className={`${styles.acctRowIcon} ${styles.iconMuted}`}>✉</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>Contact support</span>
                    <span className={styles.acctRowSub}>support@mediant.app</span>
                  </div>
                  <span className={styles.acctRowChevron}>›</span>
                </a>
              </div>
            </div>

            {/* About */}
            <div className={styles.acctSection}>
              <p className={styles.acctSectionTitle}>About</p>
              <div className={styles.acctMenuList}>
                <div className={styles.acctRow} style={{ cursor: 'default' }}>
                  <span className={`${styles.acctRowIcon} ${styles.iconMuted}`}>ℹ</span>
                  <div className={styles.acctRowText}>
                    <span className={styles.acctRowLabel}>Mediant</span>
                    <span className={styles.acctRowSub}>Version 0.1 · AI-powered music coaching</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Sign out */}
            <button className={styles.acctSignOutBtn} onClick={handleLogout}>
              <span>↩</span> Sign out
            </button>
          </div>
        </div>
      )}

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

        <div className={styles.topBarRight} ref={notifRef}>
          <div className={styles.topBarActions}>
            {/* Notifications */}
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
                  <div className={styles.dropdownFooter}>Only showing the last 30 days</div>
                </div>
              )}
            </div>
          </div>

          {/* User chip → opens full-screen account overlay */}
          {user && (
            <button
              className={`${styles.topBarUserChip} ${panel === 'account' ? styles.topBarUserChipActive : ''}`}
              onClick={() => setPanel(p => p === 'account' ? null : 'account')}
            >
              <span className={styles.topBarAvatar}>{initials}</span>
              <span className={styles.topBarName}>{user.name}</span>
            </button>
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
                <button
                  className={styles.userBtn}
                  onClick={() => setPanel(p => p === 'account' ? null : 'account')}
                  title="Account"
                >
                  <span className={styles.userAvatar}>{initials}</span>
                </button>
                <span className={styles.tooltip}>{user.name}</span>
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
    <svg width="26" height="30" viewBox="0 0 84 84" fill="none" xmlns="http://www.w3.org/2000/svg">
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
