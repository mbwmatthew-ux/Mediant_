import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { supabase } from '../lib/supabase'
import { playToggle, playSave, playThud, playTick } from '../utils/sounds'
import { INSTRUMENTS } from '../lib/instruments'
import styles from './Settings.module.css'

function Toggle({ checked, onChange }) {
  return (
    <button
      className={`${styles.toggle} ${checked ? styles.toggleOn : ''}`}
      onClick={onChange}
      role="switch"
      aria-checked={checked}
    >
      <span className={styles.toggleKnob} />
    </button>
  )
}

function Row({ icon, label, sub, onClick, danger, children, value }) {
  return (
    <div
      className={`${styles.row} ${onClick ? styles.rowClickable : ''} ${danger ? styles.rowDanger : ''}`}
      onClick={onClick}
    >
      {icon && <span className={styles.rowIcon}>{icon}</span>}
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {sub && <span className={styles.rowSub}>{sub}</span>}
      </div>
      {value && <span className={styles.rowValue}>{value}</span>}
      {children && <div className={styles.rowControl}>{children}</div>}
      {onClick && !children && <span className={styles.rowChevron}>›</span>}
    </div>
  )
}

export default function Settings() {
  const { user, subscription, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const nav = useNavigate()

  const [name,       setName]       = useState(user?.name ?? '')
  const [instrument, setInstrument] = useState(user?.instrument ?? 'Piano')
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved

  const [soundOn, setSoundOn] = useState(
    () => localStorage.getItem('mediant_sound') !== 'false'
  )

  const initials = (user?.name ?? '?')
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  async function saveProfile() {
    if (saveStatus === 'saving') return
    setSaveStatus('saving')
    try {
      await supabase.auth.updateUser({ data: { name, instrument } })
      playSave()
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2200)
    } catch {
      setSaveStatus('idle')
    }
  }

  function handleThemeToggle() {
    playToggle(theme !== 'dark')
    toggleTheme()
  }

  function handleSoundToggle() {
    const next = !soundOn
    setSoundOn(next)
    localStorage.setItem('mediant_sound', String(next))
    if (next) playToggle(true)
  }

  function handleSignOut() {
    playThud()
    logout()
    nav('/')
  }

  function handleClearData() {
    playThud()
    localStorage.clear()
  }

  const isPaid = subscription?.plan && subscription.plan !== 'free'

  return (
    <div className={styles.page}>

      {/* ── Header ── */}
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Settings</h1>
        <p className={styles.pageSub}>Manage your profile, preferences, and account.</p>
      </div>

      {/* ── Profile ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Profile</h2>
        <div className={styles.card}>
          <div className={styles.profileCard}>

            <div className={styles.profileTop}>
              <div className={styles.avatar}>{initials}</div>
              <div className={styles.profileMeta}>
                <span style={{ fontSize: '0.925rem', fontWeight: 500, color: 'var(--text)' }}>
                  {user?.name ?? 'Guest'}
                </span>
                <span className={styles.profileEmail}>{user?.email}</span>
                <span className={`${styles.planBadge} ${isPaid ? '' : styles.planBadgeFree}`}>
                  {isPaid ? `${subscription.plan} plan` : 'Free plan'}
                </span>
              </div>
            </div>

            <div className={styles.profileFields}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Display name</label>
                <input
                  className={styles.fieldInput}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Your name"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Primary instrument</label>
                <select
                  className={styles.fieldSelect}
                  value={instrument}
                  onChange={e => { playTick(); setInstrument(e.target.value) }}
                >
                  {INSTRUMENTS.map(i => <option key={i}>{i}</option>)}
                </select>
              </div>
            </div>

            <div className={styles.profileFooter}>
              <button
                className={`${styles.saveBtn} ${saveStatus === 'saved' ? styles.saveBtnSaved : ''}`}
                onClick={saveProfile}
                disabled={saveStatus === 'saving'}
              >
                {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? '✓ Saved' : 'Save changes'}
              </button>
            </div>

          </div>
        </div>
      </section>

      {/* ── Appearance ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Appearance</h2>
        <div className={styles.card}>
          <Row
            icon={theme === 'dark' ? '🌙' : '☀️'}
            label="Dark mode"
            sub="Switch between light and dark theme"
          >
            <Toggle checked={theme === 'dark'} onChange={handleThemeToggle} />
          </Row>
        </div>
      </section>

      {/* ── Sound ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Sound</h2>
        <div className={styles.card}>
          <Row
            icon="♪"
            label="Sound effects"
            sub="Subtle audio feedback for interactions and analysis"
          >
            <Toggle checked={soundOn} onChange={handleSoundToggle} />
          </Row>
        </div>
      </section>

      {/* ── Plan ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Plan & Billing</h2>
        <div className={styles.card}>
          <Row
            icon="◈"
            label="Current plan"
            value={isPaid ? `${subscription.plan}` : 'Free'}
          />
          <Row
            icon="↑"
            label={isPaid ? 'Manage billing' : 'Upgrade to Pro'}
            sub={isPaid ? 'View invoices and manage your subscription' : 'Unlimited analyses, priority processing'}
            onClick={() => { playTick(); nav('/pricing') }}
          />
        </div>
      </section>

      {/* ── Help ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Help</h2>
        <div className={styles.card}>

          <Row icon="⌨" label="Keyboard shortcuts">
            <div /> {/* spacer — shortcuts are inlined below */}
          </Row>
          <div className={styles.shortcutsGrid}>
            {[
              ['Space',  'Play / pause'],
              ['← →',   'Previous / next measure'],
              ['L',      'Toggle loop on current section'],
              ['Esc',    'Close any panel'],
              ['R',      'Go to upload recording'],
              ['S',      'Go to score review'],
            ].map(([key, desc]) => (
              <div key={key} className={styles.shortcutRow}>
                <kbd className={styles.shortcutKey}>{key}</kbd>
                <span className={styles.shortcutDesc}>{desc}</span>
              </div>
            ))}
          </div>

          <Row
            icon="✉"
            label="Contact support"
            sub="mediantteam@gmail.com"
            onClick={() => window.location.href = 'mailto:mediantteam@gmail.com'}
          />
        </div>
      </section>

      {/* ── Privacy ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Privacy & Data</h2>
        <div className={styles.card}>
          <div className={styles.dangerArea}>
            <p className={styles.dangerBody}>
              Your recordings and analysis results are stored locally in your browser and are never shared with third parties. Analysis is processed securely and subject to our privacy policy.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className={styles.dangerBtn} onClick={handleClearData}>
                Clear all local data
              </button>
              <Link to="/privacy" className={styles.dangerBtn} style={{ textDecoration: 'none' }}>
                Privacy policy ↗
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── About ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>About</h2>
        <div className={styles.card}>
          <div className={styles.versionRow}>
            <span className={styles.versionLabel}>Mediant</span>
            <span className={styles.versionValue}>Version 0.1</span>
          </div>
          <div className={styles.versionRow}>
            <span className={styles.versionLabel}>Music performance analysis</span>
            <a href="/terms" className={styles.versionLink}>Terms ↗</a>
          </div>
        </div>
      </section>

      {/* ── Sign out ── */}
      <button className={styles.signOutBtn} onClick={handleSignOut}>
        Sign out
      </button>

    </div>
  )
}
