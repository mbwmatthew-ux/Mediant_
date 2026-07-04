import { useEffect, useRef, useState } from 'react'
import styles from './NotificationsPopup.module.css'

const MOCK_NOTIFS = [
  {
    id: 1,
    type: 'analysis',
    title: 'Analysis complete',
    body: 'Bach — Cello Suite No. 1 · 3 issues flagged',
    time: '2m ago',
    read: false,
  },
  {
    id: 2,
    type: 'pattern',
    title: 'Recurring issue detected',
    body: 'Intonation flagged in your last 4 sessions',
    time: '1h ago',
    read: false,
  },
  {
    id: 3,
    type: 'analysis',
    title: 'Analysis complete',
    body: 'Debussy — Clair de lune · Score: 81',
    time: 'Yesterday',
    read: true,
  },
  {
    id: 4,
    type: 'tip',
    title: 'Practice tip',
    body: 'You haven\'t recorded in 3 days. Keep your streak going.',
    time: '2d ago',
    read: true,
  },
]

function NotifIcon({ type }) {
  if (type === 'analysis') return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
    </svg>
  )
  if (type === 'pattern') return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  )
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  )
}

export default function NotificationsPopup({ onClose }) {
  const [notifs, setNotifs] = useState(MOCK_NOTIFS)
  const ref = useRef(null)

  useEffect(() => {
    function onDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function markAllRead() {
    setNotifs(n => n.map(x => ({ ...x, read: true })))
  }

  const unread = notifs.filter(n => !n.read).length

  return (
    <div className={styles.popup} ref={ref} role="dialog" aria-label="Notifications">
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>Notifications</span>
          {unread > 0 && <span className={styles.badge}>{unread}</span>}
        </div>
        {unread > 0 && (
          <button className={styles.markAllBtn} onClick={markAllRead}>
            Mark all read
          </button>
        )}
      </div>

      <div className={styles.list}>
        {notifs.length === 0 ? (
          <div className={styles.empty}>No notifications yet.</div>
        ) : (
          notifs.map(n => (
            <div
              key={n.id}
              className={`${styles.item} ${!n.read ? styles.itemUnread : ''}`}
              onClick={() => setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x))}
            >
              <div className={`${styles.iconWrap} ${styles[`icon_${n.type}`] ?? ''}`}>
                <NotifIcon type={n.type} />
              </div>
              <div className={styles.itemBody}>
                <span className={styles.itemTitle}>{n.title}</span>
                <span className={styles.itemDesc}>{n.body}</span>
              </div>
              <div className={styles.itemRight}>
                <span className={styles.itemTime}>{n.time}</span>
                {!n.read && <span className={styles.dot} />}
              </div>
            </div>
          ))
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.footerNote}>Real-time notifications coming soon.</span>
      </div>
    </div>
  )
}
