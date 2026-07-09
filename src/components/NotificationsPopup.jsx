import { useEffect, useRef, useState } from 'react'
import styles from './NotificationsPopup.module.css'

export default function NotificationsPopup({ onClose }) {
  const [notifs] = useState([])
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

  return (
    <div className={styles.popup} ref={ref} role="dialog" aria-label="Notifications">
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>Notifications</span>
        </div>
      </div>

      <div className={styles.list}>
        <div className={styles.empty}>No notifications yet.</div>
      </div>
    </div>
  )
}
