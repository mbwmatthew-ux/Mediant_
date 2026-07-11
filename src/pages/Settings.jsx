import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { supabase } from '../lib/supabase'
import { playToggle, playSave, playThud, playTick } from '../utils/sounds'
import { INSTRUMENTS } from '../lib/instruments'
import styles from './Settings.module.css'

/* ── Sidebar nav items ───────────────────────────────────────── */
const NAV_ITEMS = [
  { id: 'profile',     label: 'Profile',     icon: UserIcon      },
  { id: 'preferences', label: 'Preferences', icon: SlidersIcon   },
  { id: 'security',    label: 'Security',    icon: LockIcon      },
  { id: 'plan',        label: 'Plan',        icon: CreditCardIcon},
  { id: 'privacy',     label: 'Privacy',     icon: ShieldIcon    },
  { id: 'danger',      label: 'Danger zone', icon: AlertIcon, danger: true },
]

/* ── Shared primitives ───────────────────────────────────────── */

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      className={`${styles.toggle} ${checked ? styles.toggleOn : ''}`}
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
    >
      <span className={styles.toggleKnob} />
    </button>
  )
}

function SettingRow({ label, sub, children, mono, danger }) {
  return (
    <div className={`${styles.settingRow} ${danger ? styles.settingRowDanger : ''}`}>
      <div className={styles.settingRowLeft}>
        <span className={`${styles.settingLabel} ${danger ? styles.settingLabelDanger : ''}`}>{label}</span>
        {sub && <span className={styles.settingDesc}>{sub}</span>}
      </div>
      <div className={`${styles.settingRowRight} ${mono ? styles.settingRowRightMono : ''}`}>
        {children}
      </div>
    </div>
  )
}

function SectionHeader({ title, sub }) {
  return (
    <div className={styles.sectionHeader}>
      <h1 className={styles.sectionTitle}>{title}</h1>
      {sub && <p className={styles.sectionSub}>{sub}</p>}
    </div>
  )
}

function StatusMsg({ kind, children }) {
  if (!children) return null
  return (
    <span className={`${styles.statusMsg} ${kind === 'ok' ? styles.statusOk : kind === 'err' ? styles.statusErr : ''}`}>
      {children}
    </span>
  )
}

function Btn({ variant = 'ghost', children, ...props }) {
  const cls = {
    primary:   styles.btnPrimary,
    secondary: styles.btnSecondary,
    danger:    styles.btnDanger,
    ghost:     styles.btnGhost,
  }[variant] ?? styles.btnGhost
  return <button className={`${styles.btn} ${cls}`} {...props}>{children}</button>
}

/* ── Profile section ─────────────────────────────────────────── */

function ProfileSection() {
  const { user } = useAuth()
  const [name,          setName]          = useState(user?.name ?? '')
  const [instrument,    setInstrument]    = useState(user?.instrument ?? 'Piano')
  const [coachingStyle, setCoachingStyle] = useState(user?.coaching_style ?? 'Balanced')
  const [defaultNote,   setDefaultNote]   = useState(user?.default_note ?? '')
  const [status,        setStatus]        = useState('idle')

  async function save() {
    if (status === 'saving') return
    setStatus('saving')
    try {
      await supabase.auth.updateUser({ data: { name, instrument, coaching_style: coachingStyle, default_note: defaultNote.trim() } })
      playSave()
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2500)
    } catch { setStatus('idle') }
  }

  const initials = (user?.name ?? '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className={styles.section}>
      <SectionHeader title="Profile" sub="Your account identity and AI coaching preferences." />

      <div className={styles.card}>
        <div className={styles.avatarRow}>
          <div className={styles.avatar}>{initials}</div>
          <div className={styles.avatarMeta}>
            <span className={styles.avatarName}>{user?.name || 'No name set'}</span>
            <span className={styles.avatarEmail}>{user?.email}</span>
          </div>
        </div>
        <div className={styles.cardDivider} />

        <SettingRow label="Display name" sub="Shown in session history and coaching messages.">
          <input className={styles.input} value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
        </SettingRow>

        <SettingRow label="Email" sub="Your sign-in address.">
          <input className={styles.input} value={user?.email ?? ''} readOnly />
        </SettingRow>

        <SettingRow label="Primary instrument" sub="Used to tailor feedback language and technique tips.">
          <select className={styles.select} value={instrument} onChange={e => { playTick(); setInstrument(e.target.value) }}>
            {INSTRUMENTS.map(i => <option key={i}>{i}</option>)}
          </select>
        </SettingRow>

        <SettingRow label="Coaching style" sub="How the AI coach phrases its feedback.">
          <select className={styles.select} value={coachingStyle} onChange={e => { playTick(); setCoachingStyle(e.target.value) }}>
            <option value="Balanced">Balanced</option>
            <option value="Encouraging">Encouraging</option>
            <option value="Technical">Technical</option>
            <option value="Direct">Direct</option>
          </select>
        </SettingRow>

        <SettingRow label="AI context note" sub="Pre-fills on every new session — instrument quirks, injuries, or setup notes.">
          <textarea
            className={styles.textarea}
            value={defaultNote}
            onChange={e => setDefaultNote(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="e.g. 'My bow arm tends to collapse on down-bows' or 'I use alternate tuning'"
          />
        </SettingRow>

        <div className={styles.cardFooter}>
          <StatusMsg kind={status === 'saved' ? 'ok' : ''}>{status === 'saved' ? 'Changes saved.' : ''}</StatusMsg>
          <Btn variant="primary" onClick={save} disabled={status === 'saving'}>
            {status === 'saving' ? 'Saving…' : 'Save profile'}
          </Btn>
        </div>
      </div>
    </div>
  )
}

/* ── Preferences section ─────────────────────────────────────── */

function PreferencesSection() {
  const { theme, toggleTheme } = useTheme()
  const [soundOn, setSoundOn] = useState(
    () => localStorage.getItem('mediant_sound') !== 'false'
  )

  function handleTheme() { playToggle(theme !== 'dark'); toggleTheme() }
  function handleSound() {
    const next = !soundOn
    setSoundOn(next)
    localStorage.setItem('mediant_sound', String(next))
    if (next) playToggle(true)
  }

  return (
    <div className={styles.section}>
      <SectionHeader title="Preferences" sub="Appearance and audio feedback." />

      <div className={styles.card}>
        <SettingRow label="Dark mode" sub="Switch between light and dark interface theme.">
          <Toggle checked={theme === 'dark'} onChange={handleTheme} />
        </SettingRow>
        <SettingRow label="Sound effects" sub="Subtle audio cues for interactions and analysis events.">
          <Toggle checked={soundOn} onChange={handleSound} />
        </SettingRow>
      </div>

      <div className={styles.groupLabel}>Keyboard shortcuts</div>
      <div className={styles.card}>
        {[
          ['Space', 'Play / pause video'],
          ['← →',   'Previous / next measure'],
          ['L',      'Toggle loop on selected section'],
          ['Esc',    'Close panel or menu'],
          ['R',      'Open new recording'],
          ['S',      'Go to score view'],
        ].map(([key, desc]) => (
          <div key={key} className={styles.shortcutRow}>
            <kbd className={styles.kbd}>{key}</kbd>
            <span className={styles.shortcutDesc}>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Security section ────────────────────────────────────────── */

function SecuritySection() {
  const { user } = useAuth()
  const [pw,    setPw]    = useState('')
  const [pw2,   setPw2]   = useState('')
  const [pwState, setPwState] = useState('idle')
  const [pwMsg,   setPwMsg]   = useState('')
  const [email, setEmail] = useState('')
  const [emState, setEmState] = useState('idle')
  const [emMsg,   setEmMsg]   = useState('')

  async function submitPassword(e) {
    e.preventDefault()
    if (pwState === 'saving') return
    if (pw.length < 8)  { setPwState('err'); setPwMsg('Minimum 8 characters.'); return }
    if (pw !== pw2)     { setPwState('err'); setPwMsg("Passwords don't match."); return }
    setPwState('saving'); setPwMsg('')
    const { error } = await supabase.auth.updateUser({ password: pw })
    if (error) { setPwState('err'); setPwMsg(error.message); return }
    playSave(); setPwState('ok'); setPwMsg('Password updated.')
    setPw(''); setPw2('')
    setTimeout(() => { setPwState('idle'); setPwMsg('') }, 3500)
  }

  async function submitEmail(e) {
    e.preventDefault()
    if (emState === 'saving') return
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setEmState('err'); setEmMsg('Enter a valid email.'); return }
    setEmState('saving'); setEmMsg('')
    const { error } = await supabase.auth.updateUser({ email })
    if (error) { setEmState('err'); setEmMsg(error.message); return }
    playSave(); setEmState('ok'); setEmMsg('Confirmation link sent — check your inbox.')
    setEmail('')
    setTimeout(() => { setEmState('idle'); setEmMsg('') }, 5000)
  }

  return (
    <div className={styles.section}>
      <SectionHeader title="Security" sub="Manage your password, email address, and two-factor authentication." />

      <div className={styles.groupLabel}>Password</div>
      <div className={styles.card}>
        <form onSubmit={submitPassword}>
          <SettingRow label="New password">
            <input className={styles.input} type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} placeholder="At least 8 characters" />
          </SettingRow>
          <SettingRow label="Confirm password">
            <input className={styles.input} type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Re-enter password" />
          </SettingRow>
          <div className={styles.cardFooter}>
            <StatusMsg kind={pwState === 'ok' ? 'ok' : pwState === 'err' ? 'err' : ''}>{pwMsg}</StatusMsg>
            <Btn variant="primary" type="submit" disabled={pwState === 'saving' || !pw || !pw2}>
              {pwState === 'saving' ? 'Updating…' : 'Update password'}
            </Btn>
          </div>
        </form>
      </div>

      <div className={styles.groupLabel}>Email address</div>
      <div className={styles.card}>
        <SettingRow label="Current email" mono>
          <span className={styles.monoValue}>{user?.email ?? '—'}</span>
        </SettingRow>
        <form onSubmit={submitEmail}>
          <SettingRow label="New email">
            <input className={styles.input} type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
          </SettingRow>
          <div className={styles.cardFooter}>
            <StatusMsg kind={emState === 'ok' ? 'ok' : emState === 'err' ? 'err' : ''}>{emMsg}</StatusMsg>
            <Btn variant="primary" type="submit" disabled={emState === 'saving' || !email}>
              {emState === 'saving' ? 'Sending…' : 'Send confirmation'}
            </Btn>
          </div>
        </form>
      </div>

      <div className={styles.groupLabel}>Two-factor authentication</div>
      <div className={styles.card}>
        <SettingRow label="Authenticator app" sub="TOTP via Google Authenticator, Authy, or 1Password.">
          <span className={styles.comingSoon}>Coming soon</span>
        </SettingRow>
      </div>
    </div>
  )
}

/* ── Plan / billing section ──────────────────────────────────── */

function BillingSection() {
  const { subscription } = useAuth()
  const nav = useNavigate()

  const isPaid   = subscription?.plan && subscription.plan !== 'free'
  const planName = isPaid ? subscription.plan : 'Free'
  const renewal  = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : null

  return (
    <div className={styles.section}>
      <SectionHeader title="Plan" sub="Manage your Mediant subscription." />

      <div className={styles.card}>
        <SettingRow label="Current plan" mono>
          <div className={styles.planRow}>
            <span className={`${styles.planBadge} ${isPaid ? styles.planBadgePaid : styles.planBadgeFree}`}>
              {planName}
            </span>
            {renewal && <span className={styles.monoValue}>Renews {renewal}</span>}
          </div>
        </SettingRow>
        <SettingRow label="Payment method" sub="Billing is handled by Stripe — card details never touch Mediant servers.">
          <Btn variant="secondary" onClick={() => { playTick(); nav('/pricing') }}>
            {isPaid ? 'Manage billing' : 'Upgrade to Pro'}
          </Btn>
        </SettingRow>
      </div>
    </div>
  )
}

/* ── Privacy section ─────────────────────────────────────────── */

function PrivacySection() {
  const [clearState, setClearState] = useState('idle')

  function clearCache() {
    if (clearState !== 'confirm') { playTick(); setClearState('confirm'); return }
    playThud()
    try { indexedDB.deleteDatabase('mediant_files') } catch { /* ignore */ }
    setClearState('done')
    setTimeout(() => setClearState('idle'), 2600)
  }

  return (
    <div className={styles.section}>
      <SectionHeader title="Privacy" sub="How your data is stored and how you can manage it." />

      <div className={styles.card}>
        <SettingRow label="Data handling" sub="Your recordings are processed only to generate feedback and are never sold or shared with advertisers.">
          <Link to="/privacy" className={styles.linkBtn}>Privacy policy ↗</Link>
        </SettingRow>
        <SettingRow label="Cached recordings" sub="Clears browser-cached media. Nothing is deleted from your account.">
          <div className={styles.rowActions}>
            {clearState === 'done'
              ? <StatusMsg kind="ok">Cache cleared.</StatusMsg>
              : <>
                  <Btn
                    variant={clearState === 'confirm' ? 'danger' : 'secondary'}
                    onClick={clearCache}
                  >
                    {clearState === 'confirm' ? 'Confirm clear' : 'Clear cache'}
                  </Btn>
                  {clearState === 'confirm' && (
                    <Btn variant="ghost" onClick={() => setClearState('idle')}>Cancel</Btn>
                  )}
                </>
            }
          </div>
        </SettingRow>
      </div>
    </div>
  )
}

/* ── Danger section ──────────────────────────────────────────── */

function DangerSection() {
  const { logout } = useAuth()
  const nav = useNavigate()
  const [state, setState] = useState('idle')
  const [err,   setErr]   = useState('')

  async function deleteAccount() {
    if (state === 'idle') { playTick(); setState('confirm'); return }
    if (state !== 'confirm') return
    playThud(); setState('deleting'); setErr('')
    try {
      const { data, error } = await supabase.functions.invoke('delete-account')
      if (error || !data?.ok) {
        setState('error')
        setErr(error?.message ?? data?.error ?? 'Something went wrong. Email mediantteam@gmail.com.')
        return
      }
      await logout(); nav('/')
    } catch (e) {
      setState('error'); setErr(e?.message ?? 'Something went wrong.')
    }
  }

  return (
    <div className={styles.section}>
      <SectionHeader title="Danger zone" sub="Irreversible actions. Proceed carefully." />

      <div className={`${styles.card} ${styles.dangerCard}`}>
        <SettingRow
          label="Delete account"
          sub="Permanently removes your account, recordings, sessions, and all feedback. This cannot be undone."
          danger
        >
          <div className={styles.rowActions}>
            <Btn
              variant="danger"
              onClick={deleteAccount}
              disabled={state === 'deleting'}
            >
              {state === 'deleting' ? 'Deleting…' : state === 'confirm' ? 'Confirm — delete everything' : 'Delete account'}
            </Btn>
            {(state === 'confirm' || state === 'error') && (
              <Btn variant="ghost" onClick={() => { setState('idle'); setErr('') }}>Cancel</Btn>
            )}
          </div>
        </SettingRow>
        {err && <div className={styles.cardError}>{err}</div>}
      </div>
    </div>
  )
}

/* ── Section map ─────────────────────────────────────────────── */

const SECTION_MAP = {
  profile:     ProfileSection,
  preferences: PreferencesSection,
  security:    SecuritySection,
  plan:        BillingSection,
  privacy:     PrivacySection,
  danger:      DangerSection,
}

/* ── Page ────────────────────────────────────────────────────── */

export default function Settings() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const [active, setActive] = useState('profile')

  const ActiveSection = SECTION_MAP[active] ?? ProfileSection
  const initials = (user?.name ?? '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  function pick(id) { playTick(); setActive(id) }
  function signOut() { playThud(); logout(); nav('/') }

  return (
    <div className={styles.page}>

      {/* ── Settings sidebar (desktop) ───────────────────── */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarUser}>
          <div className={styles.sidebarAvatar}>{initials}</div>
          <div className={styles.sidebarMeta}>
            <span className={styles.sidebarName}>{user?.name || 'Account'}</span>
            <span className={styles.sidebarEmail}>{user?.email}</span>
          </div>
        </div>

        <nav className={styles.navList} aria-label="Settings sections">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`${styles.navItem} ${active === item.id ? styles.navItemActive : ''} ${item.danger ? styles.navItemDanger : ''}`}
              onClick={() => pick(item.id)}
              aria-current={active === item.id ? 'page' : undefined}
            >
              <span className={styles.navIcon}><item.icon /></span>
              <span className={styles.navLabel}>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <button className={styles.signOutBtn} onClick={signOut}>
            <span className={styles.navIcon}><LogOutIcon /></span>
            <span className={styles.navLabel}>Sign out</span>
          </button>
        </div>
      </aside>

      {/* ── Right column (tabs + content) ────────────────── */}
      <div className={styles.contentWrap}>

        {/* Mobile tab strip */}
        <div className={styles.mobileTabs}>
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`${styles.mobileTab} ${active === item.id ? styles.mobileTabActive : ''} ${item.danger ? styles.mobileTabDanger : ''}`}
              onClick={() => pick(item.id)}
            >
              {item.label}
            </button>
          ))}
          <button className={styles.mobileSignOut} onClick={signOut}>Sign out</button>
        </div>

        {/* Section content */}
        <div className={styles.content}>
          <ActiveSection key={active} />
        </div>

      </div>
    </div>
  )
}

/* ── Icons ───────────────────────────────────────────────────── */

function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4"/>
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
    </svg>
  )
}

function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6"/>
      <line x1="4" y1="12" x2="20" y2="12"/>
      <line x1="4" y1="18" x2="20" y2="18"/>
      <circle cx="8"  cy="6"  r="2" fill="currentColor" stroke="none"/>
      <circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/>
      <circle cx="10" cy="18" r="2" fill="currentColor" stroke="none"/>
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="11" rx="2"/>
      <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
    </svg>
  )
}

function CreditCardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2"/>
      <line x1="2" y1="10" x2="22" y2="10"/>
      <line x1="6" y1="15" x2="10" y2="15"/>
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L4 6v6c0 5.25 3.5 10.15 8 11.35C16.5 22.15 20 17.25 20 12V6l-8-4z"/>
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )
}

function LogOutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  )
}
