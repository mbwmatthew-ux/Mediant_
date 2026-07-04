import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { supabase } from '../lib/supabase'
import { playToggle, playSave, playThud, playTick } from '../utils/sounds'
import { INSTRUMENTS } from '../lib/instruments'
import styles from './Settings.module.css'

/* ── Tab structure ───────────────────────────────────────────── */
const TABS = [
  { id: 'profile',     label: 'Profile'     },
  { id: 'preferences', label: 'Preferences' },
  { id: 'security',    label: 'Security'    },
  { id: 'plan',        label: 'Plan'        },
  { id: 'privacy',     label: 'Privacy'     },
  { id: 'danger',      label: 'Danger zone', danger: true },
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

function SectionHeader({ eyebrow, title, sub }) {
  return (
    <div>
      {eyebrow && <span className={styles.sectionEyebrow}>{eyebrow}</span>}
      <h2 className={styles.sectionTitle}>{title}</h2>
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
      <SectionHeader eyebrow="General" title="Profile" sub="Your account identity and AI coaching preferences." />

      <div className={styles.card}>
        {/* Avatar row */}
        <div className={styles.avatarRow}>
          <div className={styles.avatar}>{initials}</div>
          <div className={styles.avatarMeta}>
            <span className={styles.avatarName}>{user?.name || 'No name set'}</span>
            <span className={styles.avatarEmail}>{user?.email}</span>
          </div>
        </div>
        <div className={styles.cardDivider} />

        <SettingRow label="Display name" sub="Shown in session history and coaching messages.">
          <input
            className={styles.input}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Your name"
          />
        </SettingRow>

        <SettingRow label="Email" sub="Your sign-in email address.">
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
            placeholder="e.g. 'My bow arm tends to collapse on down-bows' or 'I use a thumb piano with alternate tuning'"
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
      <SectionHeader eyebrow="General" title="Preferences" sub="Appearance and audio feedback." />
      <div className={styles.card}>
        <SettingRow label="Dark mode" sub="Switch between light and dark interface theme.">
          <Toggle checked={theme === 'dark'} onChange={handleTheme} />
        </SettingRow>
        <SettingRow label="Sound effects" sub="Subtle audio cues for interactions and analysis events.">
          <Toggle checked={soundOn} onChange={handleSound} />
        </SettingRow>
      </div>

      {/* Keyboard shortcuts */}
      <div className={styles.subsectionHeader}>Keyboard shortcuts</div>
      <div className={styles.card}>
        {[
          ['Space',  'Play / pause video'],
          ['←  →',   'Previous / next measure'],
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

/* ── Password section ────────────────────────────────────────── */

function PasswordSection({ standalone = true }) {
  const [pw,    setPw]    = useState('')
  const [pw2,   setPw2]   = useState('')
  const [state, setState] = useState('idle')
  const [msg,   setMsg]   = useState('')

  async function submit(e) {
    e.preventDefault()
    if (state === 'saving') return
    if (pw.length < 8)  { setState('err'); setMsg('Minimum 8 characters.'); return }
    if (pw !== pw2)     { setState('err'); setMsg("Passwords don't match."); return }
    setState('saving'); setMsg('')
    const { error } = await supabase.auth.updateUser({ password: pw })
    if (error) { setState('err'); setMsg(error.message); return }
    playSave()
    setState('ok'); setMsg('Password updated.')
    setPw(''); setPw2('')
    setTimeout(() => { setState('idle'); setMsg('') }, 3500)
  }

  const inner = (
    <div className={styles.card}>
      <form onSubmit={submit}>
        <SettingRow label="New password">
          <input className={styles.input} type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} placeholder="At least 8 characters" />
        </SettingRow>
        <SettingRow label="Confirm password">
          <input className={styles.input} type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Re-enter password" />
        </SettingRow>
        <div className={styles.cardFooter}>
          <StatusMsg kind={state === 'ok' ? 'ok' : state === 'err' ? 'err' : ''}>{msg}</StatusMsg>
          <Btn variant="primary" type="submit" disabled={state === 'saving' || !pw || !pw2}>
            {state === 'saving' ? 'Updating…' : 'Update password'}
          </Btn>
        </div>
      </form>
    </div>
  )

  if (!standalone) return inner
  return (
    <div className={styles.section}>
      <SectionHeader title="Password" sub="Choose a strong password — at least 8 characters." />
      {inner}
    </div>
  )
}

/* ── Email section ───────────────────────────────────────────── */

function EmailSectionInner() {
  const { user } = useAuth()
  const [email, setEmail] = useState('')
  const [state, setState] = useState('idle')
  const [msg,   setMsg]   = useState('')

  async function submit(e) {
    e.preventDefault()
    if (state === 'saving') return
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setState('err'); setMsg('Enter a valid email.'); return }
    setState('saving'); setMsg('')
    const { error } = await supabase.auth.updateUser({ email })
    if (error) { setState('err'); setMsg(error.message); return }
    playSave()
    setState('ok'); setMsg('Confirmation link sent — check your inbox.')
    setEmail('')
    setTimeout(() => { setState('idle'); setMsg('') }, 5000)
  }

  return (
    <div className={styles.card}>
      <SettingRow label="Current email" mono>
        <span className={styles.monoValue}>{user?.email ?? '—'}</span>
      </SettingRow>
      <form onSubmit={submit}>
        <SettingRow label="New email">
          <input className={styles.input} type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
        </SettingRow>
        <div className={styles.cardFooter}>
          <StatusMsg kind={state === 'ok' ? 'ok' : state === 'err' ? 'err' : ''}>{msg}</StatusMsg>
          <Btn variant="primary" type="submit" disabled={state === 'saving' || !email}>
            {state === 'saving' ? 'Sending…' : 'Send confirmation'}
          </Btn>
        </div>
      </form>
    </div>
  )
}

function EmailSection() {
  return (
    <div className={styles.section}>
      <SectionHeader title="Email address" sub="Changing your email sends a confirmation link to the new address before the change takes effect." />
      <EmailSectionInner />
    </div>
  )
}

/* ── Security section (Password + Email + 2FA combined) ──────── */

function SecuritySection() {
  return (
    <div className={styles.section}>
      <SectionHeader eyebrow="Security" title="Password & login" sub="Manage your password, email address, and two-factor authentication." />
      <PasswordSection standalone={false} />
      <EmailSectionInner />
      <div className={styles.card}>
        <SettingRow label="Two-factor authentication" sub="TOTP via Google Authenticator, Authy, or 1Password.">
          <span className={styles.comingSoon}>Coming soon</span>
        </SettingRow>
      </div>
    </div>
  )
}

function TwoFactorSection() {
  return (
    <div className={styles.section}>
      <SectionHeader title="Two-factor authentication" sub="Add a second verification step at sign-in using a one-time code from an authenticator app." />
      <div className={styles.card}>
        <SettingRow label="Authenticator app" sub="TOTP via Google Authenticator, Authy, or 1Password.">
          <span className={styles.comingSoon}>Coming soon</span>
        </SettingRow>
      </div>
    </div>
  )
}

/* ── Privacy section ─────────────────────────────────────────── */

function PrivacySection() {
  const [exportState, setExportState] = useState('idle')
  const [clearState,  setClearState]  = useState('idle')

  function requestExport() {
    playTick(); setExportState('requested')
    setTimeout(() => setExportState('idle'), 5000)
  }

  function clearCache() {
    if (clearState !== 'confirm') { playTick(); setClearState('confirm'); return }
    playThud()
    try { indexedDB.deleteDatabase('mediant_files') } catch { /* ignore */ }
    setClearState('done')
    setTimeout(() => setClearState('idle'), 2600)
  }

  return (
    <div className={styles.section}>
      <SectionHeader eyebrow="Data" title="Privacy" sub="How your data is stored and how you can manage it." />
      <div className={styles.card}>
        <SettingRow label="Data handling" sub="Your recordings are processed only to generate feedback and are never sold or shared with advertisers.">
          <Link to="/privacy" className={styles.linkBtn}>Privacy policy ↗</Link>
        </SettingRow>
        <SettingRow label="Export data" sub="Request a copy of your sessions and feedback history.">
          <div className={styles.rowActions}>
            {exportState === 'requested'
              ? <StatusMsg kind="ok">Export requested — feature coming soon.</StatusMsg>
              : <Btn variant="secondary" onClick={requestExport}>Request export</Btn>
            }
          </div>
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

/* ── Plan section ────────────────────────────────────────────── */

function PlanSection({ standalone = true }) {
  const { subscription } = useAuth()
  const nav = useNavigate()

  const isPaid   = subscription?.plan && subscription.plan !== 'free'
  const planName = isPaid ? subscription.plan : 'Free'
  const renewal  = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : null

  const card = (
    <div className={styles.card}>
        <SettingRow label="Current plan" mono>
          <div className={styles.planRow}>
            <span className={`${styles.planBadge} ${isPaid ? styles.planBadgePaid : styles.planBadgeFree}`}>
              {planName}
            </span>
            {renewal && <span className={styles.monoValue}>Renews {renewal}</span>}
            {!isPaid && <span className={styles.monoValueFaint}>5 sessions / month</span>}
          </div>
        </SettingRow>
        <SettingRow label="Payment method" sub="Billing is handled by Stripe — card details never touch Mediant servers.">
          <div className={styles.rowActions}>
            {isPaid
              ? <div className={styles.cardOnFile}>
                  <span className={styles.cardBrand}>VISA</span>
                  <span className={styles.monoValue}>•••• 4242</span>
                </div>
              : null
            }
            <Btn variant="secondary" onClick={() => { playTick(); nav('/pricing') }}>
              {isPaid ? 'Change plan' : 'Upgrade to Pro'}
            </Btn>
          </div>
        </SettingRow>
      </div>
  )

  if (!standalone) return card
  return (
    <div className={styles.section}>
      <SectionHeader eyebrow="Billing" title="Plan" sub="Manage your Mediant subscription." />
      {card}
    </div>
  )
}

/* ── Invoices section ────────────────────────────────────────── */

function InvoicesSection({ standalone = true }) {
  const invoices = [
    { id: 'INV-2026-0007', date: 'Jun 1, 2026',  amount: '$14.99', status: 'paid' },
    { id: 'INV-2026-0006', date: 'May 1, 2026',  amount: '$14.99', status: 'paid' },
    { id: 'INV-2026-0005', date: 'Apr 1, 2026',  amount: '$14.99', status: 'refunded' },
  ]

  const statusStyle = { paid: styles.pillPaid, pending: styles.pillPending, refunded: styles.pillRefunded }
  const statusLabel = { paid: 'Paid', pending: 'Pending', refunded: 'Refunded' }

  const card = (
    <div className={styles.card}>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th>Amount</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invoices.map(inv => (
              <tr key={inv.id}>
                <td className={styles.mono}>{inv.id}</td>
                <td>{inv.date}</td>
                <td className={styles.mono}>{inv.amount}</td>
                <td>
                  <span className={`${styles.pill} ${statusStyle[inv.status] ?? ''}`}>
                    {statusLabel[inv.status] ?? inv.status}
                  </span>
                </td>
                <td className={styles.tableBtnCell}>
                  <button className={styles.iconBtn} disabled aria-label="Download receipt">
                    <DownloadIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )

  if (!standalone) return card
  return (
    <div className={styles.section}>
      <SectionHeader title="Invoices" sub="Download receipts for past payments. Sample data — real invoices appear once Stripe is connected." />
      {card}
    </div>
  )
}

/* ── Billing section (Plan + Invoices combined) ──────────────── */

function BillingSection() {
  return (
    <div className={styles.section}>
      <SectionHeader eyebrow="Billing" title="Plan &amp; invoices" sub="Manage your subscription and download past receipts." />
      <PlanSection standalone={false} />
      <InvoicesSection standalone={false} />
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
      <SectionHeader eyebrow="Danger zone" title="Delete account" />
      <div className={`${styles.card} ${styles.dangerCard}`}>
        <SettingRow
          label="Delete account"
          sub="Permanently remove your account, recordings, sessions, and all feedback. This cannot be undone."
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

/* ── Page ────────────────────────────────────────────────────── */

const SECTION_MAP = {
  profile:     ProfileSection,
  preferences: PreferencesSection,
  security:    SecuritySection,
  plan:        BillingSection,
  privacy:     PrivacySection,
  danger:      DangerSection,
}

export default function Settings() {
  const { logout } = useAuth()
  const nav = useNavigate()
  const [active, setActive] = useState('profile')

  function handleTab(id) {
    if (id === active) return
    playTick()
    setActive(id)
  }

  function handleBack() {
    playTick()
    if (window.history.length > 2) nav(-1)
    else nav('/home')
  }

  function handleSignOut() { playThud(); logout(); nav('/') }

  const ActiveSection = SECTION_MAP[active] ?? ProfileSection

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <button className={styles.backBtn} onClick={handleBack} aria-label="Go back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          Back
        </button>
      </div>

      <div className={styles.tabBar}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`${styles.tab} ${active === tab.id ? styles.tabActive : ''} ${tab.danger ? styles.tabDanger : ''}`}
            onClick={() => handleTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className={styles.signOutBtn} onClick={handleSignOut}>Sign out</button>
      </div>

      <ActiveSection key={active} />
    </div>
  )
}

/* ── Icons ───────────────────────────────────────────────────── */

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}
