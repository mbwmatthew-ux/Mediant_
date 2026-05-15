import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import styles from './AppShell.module.css'

const NAV = [
  { to: '/home',     label: 'Home',          icon: '⌂' },
  { to: '/search',   label: 'Find Music',    icon: '⌕' },
  { to: '/record',   label: 'Upload Take',   icon: '↑' },
  { to: '/analysis', label: 'Score Review',  icon: '◫' },
  { to: '/follow',   label: 'Follow Along',  icon: '▶' },
  { to: '/summary',  label: 'Session Summary', icon: '≡' },
  { to: '/takes',    label: 'Saved Takes',   icon: '⊙' },
  { to: '/profile',  label: 'Profile',       icon: '◯' },
]

export default function AppShell() {
  const { user, logout } = useAuth()
  const nav = useNavigate()

  function handleLogout() {
    logout()
    nav('/')
  }

  const initials = user?.name
    ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '?'

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandEyebrow}>Mediant</span>
          <h2 className={styles.brandTitle}>Practice Coach</h2>
        </div>

        <nav className={styles.nav}>
          {NAV.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
              }
            >
              <span className={styles.navIcon}>{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        {user && (
          <div className={styles.userSection}>
            <div className={styles.userRow}>
              <div className={styles.userAvatar}>{initials}</div>
              <div className={styles.userInfo}>
                <strong className={styles.userName}>{user.name}</strong>
                <span className={styles.userInstrument}>{user.instrument}</span>
              </div>
            </div>
            <button className={styles.logoutBtn} onClick={handleLogout}>
              Sign out
            </button>
          </div>
        )}
      </aside>

      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
