import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { supabase } from '../lib/supabase'
import { playToggle, playSave, playThud, playTick } from '../utils/sounds'
import { INSTRUMENTS } from '../lib/instruments'
import styles from './Settings.module.css'

/* ── Nav items ───────────────────────────────────────────────── */
const NAV_ITEMS = [
  { id: 'profile',      label: 'Profile',       desc: 'Your identity and preferences',   icon: UserIcon        },
  { id: 'account',      label: 'Account',        desc: 'Email, password, and security',   icon: LockIcon        },
  { id: 'preferences',  label: 'Preferences',    desc: 'App behavior and notifications',  icon: SlidersIcon     },
  { id: 'billing',      label: 'Billing',         desc: 'Manage your subscription',        icon: CreditCardIcon  },
  { id: 'integrations', label: 'Integrations',   desc: 'Connect third-party services',    icon: IntegrationsIcon},
  { id: 'privacy',      label: 'Data & Privacy', desc: 'Privacy and data controls',       icon: ShieldIcon      },
  { id: 'help',         label: 'Help & Support', desc: 'Get help and resources',          icon: HelpCircleIcon  },
]

const SECTION_META = {
  profile:      { Icon: UserIcon,         title: 'Profile',        sub: 'Manage your account identity and AI coaching preferences.'    },
  account:      { Icon: LockIcon,         title: 'Account',        sub: 'Manage your email, password, and account security.'           },
  preferences:  { Icon: SlidersIcon,      title: 'Preferences',    sub: 'Appearance and audio feedback settings.'                      },
  billing:      { Icon: CreditCardIcon,   title: 'Billing',         sub: 'Manage your Mediant subscription.'                            },
  integrations: { Icon: IntegrationsIcon, title: 'Integrations',   sub: 'Connect third-party services to Mediant.'                     },
  privacy:      { Icon: ShieldIcon,       title: 'Data & Privacy', sub: 'How your data is stored and how you can manage it.'           },
  help:         { Icon: HelpCircleIcon,   title: 'Help & Support', sub: 'Get help, browse docs, and contact support.'                  },
}

/* ── Shared primitives ───────────────────────────────────────── */
function Toggle({ checked, onChange, disabled }) {
  return (
    <button className={`${styles.toggle} ${checked ? styles.toggleOn : ''}`} onClick={onChange} role="switch" aria-checked={checked} disabled={disabled}>
      <span className={styles.toggleKnob} />
    </button>
  )
}

function Btn({ variant = 'ghost', children, ...props }) {
  const cls = { primary: styles.btnPrimary, secondary: styles.btnSecondary, danger: styles.btnDanger, ghost: styles.btnGhost }[variant] ?? styles.btnGhost
  return <button className={`${styles.btn} ${cls}`} {...props}>{children}</button>
}

function StatusMsg({ kind, children }) {
  if (!children) return null
  return <span className={`${styles.statusMsg} ${kind === 'ok' ? styles.statusOk : kind === 'err' ? styles.statusErr : ''}`}>{children}</span>
}

function SectionHeader({ id }) {
  const { Icon, title, sub } = SECTION_META[id] ?? SECTION_META.profile
  return (
    <div className={styles.sectionHeader}>
      <div className={styles.sectionIconWrap}><Icon /></div>
      <div>
        <h1 className={styles.sectionTitle}>{title}</h1>
        {sub && <p className={styles.sectionSub}>{sub}</p>}
      </div>
    </div>
  )
}

function CardSection({ title, desc, children, full }) {
  return (
    <div className={`${styles.card} ${full ? styles.cardFull : ''}`}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{title}</h3>
        <p className={styles.cardDesc}>{desc}</p>
      </div>
      <div className={styles.cardBody}>{children}</div>
    </div>
  )
}

function FieldGroup({ label, optional, children }) {
  return (
    <div className={styles.fieldGroup}>
      <label className={styles.fieldLabel}>{label}{optional && <span className={styles.optionalTag}> (optional)</span>}</label>
      {children}
    </div>
  )
}

function InputWrap({ icon: Icon, children }) {
  return (
    <div className={styles.inputWrap}>
      {Icon && <span className={styles.inputIcon}><Icon /></span>}
      {children}
    </div>
  )
}

/* Legacy row layout for non-profile sections */
function SettingRow({ label, sub, children, mono, danger }) {
  return (
    <div className={`${styles.settingRow} ${danger ? styles.settingRowDanger : ''}`}>
      <div className={styles.settingRowLeft}>
        <span className={`${styles.settingLabel} ${danger ? styles.settingLabelDanger : ''}`}>{label}</span>
        {sub && <span className={styles.settingDesc}>{sub}</span>}
      </div>
      <div className={`${styles.settingRowRight} ${mono ? styles.settingRowRightMono : ''}`}>{children}</div>
    </div>
  )
}

function LegacyCard({ children }) {
  return <div className={styles.card}>{children}</div>
}

/* ── Profile section ─────────────────────────────────────────── */
const COACHING_DESCRIPTIONS = {
  Balanced:    'Balanced feedback that is supportive, detailed, and actionable.',
  Encouraging: 'Warm, positive feedback that builds confidence and motivation.',
  Technical:   'Precise, analytical feedback focused on technique and music theory.',
  Direct:      'Concise, no-nonsense feedback focused on exactly what needs fixing.',
}
const SKILL_LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Professional']

function ProfileSection({ onNav }) {
  const { user } = useAuth()
  const [name,          setName]          = useState(user?.name ?? '')
  const [instrument,    setInstrument]    = useState(user?.instrument ?? 'Piano')
  const [skillLevel,    setSkillLevel]    = useState(user?.skill_level ?? '')
  const [coachingStyle, setCoachingStyle] = useState(user?.coaching_style ?? 'Balanced')
  const [contextNote,   setContextNote]   = useState(user?.default_note ?? '')
  const [status,        setStatus]        = useState('idle')

  function reset() {
    setName(user?.name ?? '')
    setInstrument(user?.instrument ?? 'Piano')
    setSkillLevel(user?.skill_level ?? '')
    setCoachingStyle(user?.coaching_style ?? 'Balanced')
    setContextNote(user?.default_note ?? '')
  }

  async function save() {
    if (status === 'saving') return
    setStatus('saving')
    try {
      await supabase.auth.updateUser({ data: { name, instrument, skill_level: skillLevel, coaching_style: coachingStyle, default_note: contextNote.trim() } })
      playSave(); setStatus('saved')
      setTimeout(() => setStatus('idle'), 2500)
    } catch { setStatus('idle') }
  }

  return (
    <div className={styles.section}>
      <SectionHeader id="profile" />
      <div className={styles.contentGrid}>
        <CardSection title="Profile" desc="This is how you'll appear in session history and coaching messages.">
          <FieldGroup label="Display name">
            <InputWrap icon={PersonInputIcon}>
              <input className={styles.inputIconed} value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
            </InputWrap>
          </FieldGroup>
        </CardSection>

        <CardSection title="Account" desc="Your sign-in email and account details.">
          <FieldGroup label="Email address">
            <InputWrap icon={MailIcon}>
              <input className={styles.inputIconed} value={user?.email ?? ''} readOnly />
            </InputWrap>
          </FieldGroup>
          <button className={`${styles.btn} ${styles.btnSecondary} ${styles.btnSmall}`} onClick={() => onNav('account')}>
            <LockSmIcon /> Change password
          </button>
        </CardSection>

        <CardSection title="Musical Preferences" desc="Tell us about your instrument so AI feedback is more relevant.">
          <FieldGroup label="Primary instrument">
            <InputWrap icon={PencilIcon}>
              <select className={styles.selectIconed} value={instrument} onChange={e => { playTick(); setInstrument(e.target.value) }}>
                {INSTRUMENTS.map(i => <option key={i}>{i}</option>)}
              </select>
            </InputWrap>
          </FieldGroup>
          <FieldGroup label="Skill level" optional>
            <InputWrap icon={BarChartSmIcon}>
              <select className={styles.selectIconed} value={skillLevel} onChange={e => { playTick(); setSkillLevel(e.target.value) }}>
                <option value="">Select level</option>
                {SKILL_LEVELS.map(l => <option key={l}>{l}</option>)}
              </select>
            </InputWrap>
          </FieldGroup>
        </CardSection>

        <CardSection title="Coaching Style" desc="Shape how the AI coach communicates with you.">
          <FieldGroup label="Coaching style">
            <InputWrap icon={SparkleIcon}>
              <select className={styles.selectIconed} value={coachingStyle} onChange={e => { playTick(); setCoachingStyle(e.target.value) }}>
                {Object.keys(COACHING_DESCRIPTIONS).map(s => <option key={s}>{s}</option>)}
              </select>
            </InputWrap>
          </FieldGroup>
          <div className={styles.coachingDesc}>
            <ChatIcon />
            <span>{COACHING_DESCRIPTIONS[coachingStyle]}</span>
          </div>
        </CardSection>

        <CardSection title="AI Context Note" desc="Add any notes about your setup, goals, or common challenges. This helps the AI coach tailor feedback to you." full>
          <div className={styles.textareaWrap}>
            <span className={styles.textareaIcon}><PencilIcon /></span>
            <textarea
              className={styles.textareaIconed}
              value={contextNote}
              onChange={e => setContextNote(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder={`e.g. "My bow arm tends to collapse on down-bows" or "I use alternate tuning"`}
            />
          </div>
          <div className={styles.charCount}>{contextNote.length} / 500</div>
        </CardSection>
      </div>

      <div className={styles.sectionFooter}>
        <StatusMsg kind={status === 'saved' ? 'ok' : ''}>{status === 'saved' ? 'Changes saved.' : ''}</StatusMsg>
        <Btn variant="ghost" onClick={reset}>Reset to defaults</Btn>
        <Btn variant="primary" onClick={save} disabled={status === 'saving'}>
          <CheckIcon /> {status === 'saving' ? 'Saving…' : 'Save changes'}
        </Btn>
      </div>
    </div>
  )
}

/* ── Account / security section ──────────────────────────────── */
function AccountSection() {
  const { user } = useAuth()
  const [pw,  setPw]  = useState('')
  const [pw2, setPw2] = useState('')
  const [pwState, setPwState] = useState('idle')
  const [pwMsg,   setPwMsg]   = useState('')
  const [email,   setEmail]   = useState('')
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
      <SectionHeader id="account" />
      <div className={styles.groupLabel}>Password</div>
      <LegacyCard>
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
      </LegacyCard>

      <div className={styles.groupLabel}>Email address</div>
      <LegacyCard>
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
      </LegacyCard>

      <div className={styles.groupLabel}>Two-factor authentication</div>
      <LegacyCard>
        <SettingRow label="Authenticator app" sub="TOTP via Google Authenticator, Authy, or 1Password.">
          <span className={styles.comingSoon}>Coming soon</span>
        </SettingRow>
      </LegacyCard>

      <div className={styles.groupLabel}>Danger zone</div>
      <DeleteAccountCard />
    </div>
  )
}

function DeleteAccountCard() {
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
      if (error || !data?.ok) { setState('error'); setErr(error?.message ?? data?.error ?? 'Something went wrong. Email mediantteam@gmail.com.'); return }
      await logout(); nav('/')
    } catch (e) { setState('error'); setErr(e?.message ?? 'Something went wrong.') }
  }

  return (
    <div className={`${styles.card} ${styles.dangerCard}`}>
      <SettingRow label="Delete account" sub="Permanently removes your account, recordings, sessions, and all feedback. This cannot be undone." danger>
        <div className={styles.rowActions}>
          <Btn variant="danger" onClick={deleteAccount} disabled={state === 'deleting'}>
            {state === 'deleting' ? 'Deleting…' : state === 'confirm' ? 'Confirm — delete everything' : 'Delete account'}
          </Btn>
          {(state === 'confirm' || state === 'error') && <Btn variant="ghost" onClick={() => { setState('idle'); setErr('') }}>Cancel</Btn>}
        </div>
      </SettingRow>
      {err && <div className={styles.cardError}>{err}</div>}
    </div>
  )
}

/* ── Preferences section ─────────────────────────────────────── */
function PreferencesSection() {
  const { theme, toggleTheme } = useTheme()
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('mediant_sound') !== 'false')

  function handleTheme() { playToggle(theme !== 'dark'); toggleTheme() }
  function handleSound() {
    const next = !soundOn; setSoundOn(next)
    localStorage.setItem('mediant_sound', String(next))
    if (next) playToggle(true)
  }

  return (
    <div className={styles.section}>
      <SectionHeader id="preferences" />
      <LegacyCard>
        <SettingRow label="Dark mode" sub="Switch between light and dark interface theme.">
          <Toggle checked={theme === 'dark'} onChange={handleTheme} />
        </SettingRow>
        <SettingRow label="Sound effects" sub="Subtle audio cues for interactions and analysis events.">
          <Toggle checked={soundOn} onChange={handleSound} />
        </SettingRow>
      </LegacyCard>
      <div className={styles.groupLabel}>Keyboard shortcuts</div>
      <LegacyCard>
        {[['Space','Play / pause'],['← →','Prev / next measure'],['L','Toggle loop'],['Esc','Close panel'],['R','New recording'],['S','Score view']].map(([k, d]) => (
          <div key={k} className={styles.shortcutRow}>
            <kbd className={styles.kbd}>{k}</kbd>
            <span className={styles.shortcutDesc}>{d}</span>
          </div>
        ))}
      </LegacyCard>
    </div>
  )
}

/* ── Billing section ─────────────────────────────────────────── */
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
      <SectionHeader id="billing" />
      <LegacyCard>
        <SettingRow label="Current plan" mono>
          <div className={styles.planRow}>
            <span className={`${styles.planBadge} ${isPaid ? styles.planBadgePaid : styles.planBadgeFree}`}>{planName}</span>
            {renewal && <span className={styles.monoValue}>Renews {renewal}</span>}
          </div>
        </SettingRow>
        <SettingRow label="Payment method" sub="Billing is handled by Stripe — card details never touch Mediant servers.">
          <Btn variant="secondary" onClick={() => { playTick(); nav('/pricing') }}>
            {isPaid ? 'Manage billing' : 'Upgrade to Pro'}
          </Btn>
        </SettingRow>
      </LegacyCard>
    </div>
  )
}

/* ── Integrations section ────────────────────────────────────── */
function IntegrationsSection() {
  return (
    <div className={styles.section}>
      <SectionHeader id="integrations" />
      <LegacyCard>
        <SettingRow label="Third-party integrations" sub="Connections to external services will appear here once available.">
          <span className={styles.comingSoon}>Coming soon</span>
        </SettingRow>
      </LegacyCard>
    </div>
  )
}

/* ── Data & Privacy section ──────────────────────────────────── */
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
      <SectionHeader id="privacy" />
      <LegacyCard>
        <SettingRow label="Data handling" sub="Your recordings are processed only to generate feedback and are never sold or shared with advertisers.">
          <Link to="/privacy" className={styles.linkBtn}>Privacy policy ↗</Link>
        </SettingRow>
        <SettingRow label="Cached recordings" sub="Clears browser-cached media. Nothing is deleted from your account.">
          <div className={styles.rowActions}>
            {clearState === 'done'
              ? <StatusMsg kind="ok">Cache cleared.</StatusMsg>
              : <>
                  <Btn variant={clearState === 'confirm' ? 'danger' : 'secondary'} onClick={clearCache}>
                    {clearState === 'confirm' ? 'Confirm clear' : 'Clear cache'}
                  </Btn>
                  {clearState === 'confirm' && <Btn variant="ghost" onClick={() => setClearState('idle')}>Cancel</Btn>}
                </>
            }
          </div>
        </SettingRow>
      </LegacyCard>
    </div>
  )
}

/* ── Help section ────────────────────────────────────────────── */
function HelpSection() {
  return (
    <div className={styles.section}>
      <SectionHeader id="help" />
      <LegacyCard>
        <SettingRow label="Documentation" sub="Guides on uploading recordings, reading feedback, and using Loop mode.">
          <span className={styles.comingSoon}>Coming soon</span>
        </SettingRow>
        <SettingRow label="Contact support" sub="Email us at mediantteam@gmail.com for help with any issue.">
          <a href="mailto:mediantteam@gmail.com" className={styles.linkBtn}>Send email ↗</a>
        </SettingRow>
      </LegacyCard>
    </div>
  )
}

/* ── Section map ─────────────────────────────────────────────── */
const SECTION_MAP = {
  profile:      ProfileSection,
  account:      AccountSection,
  preferences:  PreferencesSection,
  billing:      BillingSection,
  integrations: IntegrationsSection,
  privacy:      PrivacySection,
  help:         HelpSection,
}

/* ── Page ────────────────────────────────────────────────────── */
export default function Settings() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const [active, setActive] = useState('profile')

  const ActiveSection = SECTION_MAP[active] ?? ProfileSection

  function pick(id) { playTick(); setActive(id) }
  function signOut() { playThud(); logout(); nav('/') }

  return (
    <div className={styles.page}>

      {/* ── Settings sidebar ─────────────────────────────── */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeading}>Settings</div>
        <div className={styles.sidebarDivider} />

        <nav className={styles.navList} aria-label="Settings sections">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`${styles.navItem} ${active === item.id ? styles.navItemActive : ''}`}
              onClick={() => pick(item.id)}
              aria-current={active === item.id ? 'page' : undefined}
            >
              <span className={styles.navIcon}><item.icon /></span>
              <span className={styles.navItemText}>
                <span className={styles.navItemLabel}>{item.label}</span>
                <span className={styles.navItemDesc}>{item.desc}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className={styles.upgradeCard}>
          <span className={styles.upgradeIcon}><CrownIcon /></span>
          <p className={styles.upgradeText}>Pro tips, unlimited coaching, and more.</p>
          <button className={styles.upgradeBtn} onClick={() => { playTick(); nav('/pricing') }}>Upgrade plan</button>
        </div>

        <div className={styles.sidebarFooter}>
          <button className={styles.signOutBtn} onClick={signOut}>
            <span className={styles.navIcon}><LogOutIcon /></span>
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* ── Right column ─────────────────────────────────── */}
      <div className={styles.contentWrap}>
        {/* Mobile tab strip */}
        <div className={styles.mobileTabs}>
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`${styles.mobileTab} ${active === item.id ? styles.mobileTabActive : ''}`}
              onClick={() => pick(item.id)}
            >
              {item.label}
            </button>
          ))}
          <button className={styles.mobileSignOut} onClick={signOut}>Sign out</button>
        </div>

        <div className={styles.content}>
          <ActiveSection key={active} onNav={pick} />
        </div>
      </div>
    </div>
  )
}

/* ── Icons ───────────────────────────────────────────────────── */
function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
    </svg>
  )
}
function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
      <circle cx="8" cy="6" r="2" fill="currentColor" stroke="none"/>
      <circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/>
      <circle cx="10" cy="18" r="2" fill="currentColor" stroke="none"/>
    </svg>
  )
}
function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
    </svg>
  )
}
function LockSmIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
    </svg>
  )
}
function CreditCardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>
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
function IntegrationsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  )
}
function HelpCircleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  )
}
function LogOutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  )
}
function PersonInputIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
    </svg>
  )
}
function MailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 7 10-7"/>
    </svg>
  )
}
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  )
}
function BarChartSmIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  )
}
function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
    </svg>
  )
}
function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}
function CrownIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 20h20M4 20l2-10 6 4 4-8 4 8 6-4-2 10H4z"/>
    </svg>
  )
}
