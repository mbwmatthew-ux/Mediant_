import { useState } from 'react'
import { Link } from 'react-router-dom'
import styles from './CookieBanner.module.css'

const KEY = 'mediant_cookie_ok'

export default function CookieBanner() {
  const [dismissed, setDismissed] = useState(() => !!localStorage.getItem(KEY))

  if (dismissed) return null

  function accept() {
    localStorage.setItem(KEY, '1')
    setDismissed(true)
  }

  return (
    <div className={styles.banner} role="dialog" aria-label="Cookie notice">
      <p className={styles.text}>
        We use cookies to keep you signed in and remember your preferences — no advertising or tracking.{' '}
        <Link to="/privacy" className={styles.privacyLink}>Privacy policy</Link>
      </p>
      <div className={styles.actions}>
        <button className={styles.dismissBtn} onClick={accept}>Dismiss</button>
        <button className={styles.acceptBtn} onClick={accept}>Got it</button>
      </div>
    </div>
  )
}
