import { Link } from 'react-router-dom'
import styles from './Auth.module.css'
import LogoMark from '../components/LogoMark'

export default function ConfirmEmail() {
  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <Link to="/" className={styles.brandMark} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <LogoMark size={24} />
            Mediant
          </Link>
      </nav>

      <div className={styles.card}>
        <p className={styles.eyebrow}>Almost there</p>
        <h1 className={styles.heading}>Check your email</h1>
        <p className={styles.sub}>
          We sent a confirmation link to your email address. Click it to activate your account, then come back and log in.
        </p>

        <div style={{ background: 'rgba(44,103,75,0.08)', borderRadius: 16, padding: '18px 20px', marginBottom: 24 }}>
          <p style={{ color: 'var(--text-soft)', fontSize: '0.88rem', lineHeight: 1.65, margin: 0 }}>
            Didn&apos;t get it? Check your spam folder. The link expires in 24 hours.
          </p>
        </div>

        <Link to="/login" className={styles.submitBtn} style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
          Go to log in
        </Link>

        <p className={styles.footer}>
          Wrong email?{' '}
          <Link to="/signup" className={styles.footerLink}>Sign up again</Link>
        </p>
      </div>
    </div>
  )
}
