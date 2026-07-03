import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import styles from './TeacherDashboard.module.css'

const REJECTION_REASONS = [
  { value: 'wrong_measure', label: 'Wrong measure' },
  { value: 'not_audible',   label: 'Not audible in recording' },
  { value: 'too_harsh',     label: 'Too harsh / overstated' },
  { value: 'not_actionable', label: 'Not actionable' },
  { value: 'duplicate',     label: 'Duplicate flag' },
  { value: 'other',         label: 'Other' },
]

function timeAgo(iso) {
  if (!iso) return null
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function scoreColor(n) {
  if (n >= 88) return 'var(--score-good)'
  if (n >= 74) return 'var(--score-ok)'
  return 'var(--score-bad)'
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

export default function TeacherDashboard() {
  const nav = useNavigate()
  const { user, profile, refreshProfile } = useAuth()

  // Teacher-code redemption (shown to non-teachers)
  const [upgradeCode,    setUpgradeCode]    = useState('')
  const [upgradeState,   setUpgradeState]   = useState('idle') // idle | sending | error
  const [upgradeError,   setUpgradeError]   = useState('')

  const [relationships,   setRelationships]   = useState([])
  const [selectedStudent, setSelectedStudent] = useState(null)
  const [studentTakes,    setStudentTakes]    = useState([])
  const [selectedTake,    setSelectedTake]    = useState(null)
  const [annotations,     setAnnotations]     = useState({}) // flagIndex → annotation row

  const [inviteEmail,     setInviteEmail]     = useState('')
  const [inviteLoading,   setInviteLoading]   = useState(false)
  const [inviteError,     setInviteError]     = useState('')
  const [inviteSuccess,   setInviteSuccess]   = useState('')

  const [loading,         setLoading]         = useState(true)
  const [takesLoading,    setTakesLoading]    = useState(false)
  const [annotLoading,    setAnnotLoading]    = useState({}) // flagIndex → bool

  // Inline annotation state
  const [activeAnnot,     setActiveAnnot]     = useState(null) // { flagIndex, action }
  const [rejectReason,    setRejectReason]    = useState('wrong_measure')
  const [editedTitle,     setEditedTitle]     = useState('')
  const [editedDetail,    setEditedDetail]    = useState('')
  const [addTitle,        setAddTitle]        = useState('')
  const [addDetail,       setAddDetail]       = useState('')
  const [addMeasure,      setAddMeasure]      = useState('')
  const [addType,         setAddType]         = useState('technique')

  const supabaseUrl = supabase.supabaseUrl
  const [authToken,  setAuthToken]  = useState(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAuthToken(session?.access_token ?? null)
    })
  }, [user?.id])

  const fetchRelationships = useCallback(async () => {
    if (!authToken) return
    setLoading(true)
    try {
      const res = await fetch(
        `${supabaseUrl}/functions/v1/teacher-students`,
        { headers: { Authorization: `Bearer ${authToken}` } },
      )
      const data = await res.json()
      setRelationships(data.relationships ?? [])
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [authToken, supabaseUrl])

  useEffect(() => { fetchRelationships() }, [fetchRelationships])

  async function handleInvite(e) {
    e.preventDefault()
    if (!inviteEmail.trim()) return
    setInviteLoading(true)
    setInviteError('')
    setInviteSuccess('')
    try {
      const res = await fetch(
        `${supabaseUrl}/functions/v1/teacher-students`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ studentEmail: inviteEmail.trim() }),
        },
      )
      const data = await res.json()
      if (data.error) { setInviteError(data.error); return }
      setInviteSuccess(`Invitation sent to ${inviteEmail.trim()}.`)
      setInviteEmail('')
      fetchRelationships()
    } catch (err) {
      setInviteError(err.message)
    } finally {
      setInviteLoading(false)
    }
  }

  async function fetchStudentTakes(studentId) {
    if (!authToken) return
    setTakesLoading(true)
    setStudentTakes([])
    setSelectedTake(null)
    setAnnotations({})
    try {
      const res = await fetch(
        `${supabaseUrl}/functions/v1/teacher-students?studentId=${encodeURIComponent(studentId)}`,
        { headers: { Authorization: `Bearer ${authToken}` } },
      )
      const data = await res.json()
      setStudentTakes(data.takes ?? [])
    } catch { /* ignore */ }
    finally { setTakesLoading(false) }
  }

  function selectStudent(student) {
    if (selectedStudent?.id === student.id) {
      setSelectedStudent(null)
      setStudentTakes([])
      setSelectedTake(null)
    } else {
      setSelectedStudent(student)
      fetchStudentTakes(student.id)
    }
  }

  async function selectTake(take) {
    if (selectedTake?.id === take.id) {
      setSelectedTake(null)
      setAnnotations({})
      return
    }
    setSelectedTake(take)
    setActiveAnnot(null)

    // Load existing annotations for this take
    if (!authToken) return
    try {
      const res = await fetch(
        `${supabaseUrl}/functions/v1/annotate-flags?takeId=${encodeURIComponent(take.id)}`,
        { headers: { Authorization: `Bearer ${authToken}` } },
      )
      const data = await res.json()
      const map = {}
      for (const a of (data.annotations ?? [])) {
        map[a.flag_index ?? 'added'] = a
      }
      setAnnotations(map)
    } catch { /* ignore */ }
  }

  async function submitAnnotation(flagIndex, action, extras = {}) {
    if (!authToken || !selectedTake) return
    setAnnotLoading(prev => ({ ...prev, [flagIndex]: true }))
    try {
      const originalFlag = selectedTake.flags?.[flagIndex] ?? null
      const body = {
        takeId:          selectedTake.id,
        flagIndex:       action === 'add' ? null : flagIndex,
        action,
        originalFlag,
        ...extras,
      }
      const res = await fetch(
        `${supabaseUrl}/functions/v1/annotate-flags`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      setAnnotations(prev => ({ ...prev, [flagIndex ?? 'added']: data.annotation }))
      setActiveAnnot(null)
    } catch (err) {
      alert(err.message)
    } finally {
      setAnnotLoading(prev => ({ ...prev, [flagIndex]: false }))
    }
  }

  async function deleteAnnotation(flagIndex) {
    if (!authToken || !selectedTake) return
    try {
      await fetch(
        `${supabaseUrl}/functions/v1/annotate-flags?takeId=${encodeURIComponent(selectedTake.id)}&flagIndex=${flagIndex}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } },
      )
      setAnnotations(prev => {
        const next = { ...prev }
        delete next[flagIndex]
        return next
      })
    } catch { /* ignore */ }
  }

  function openAnnotation(flagIndex, action, flag) {
    setActiveAnnot({ flagIndex, action })
    if (action === 'edit') {
      setEditedTitle(flag?.title ?? '')
      setEditedDetail(flag?.detail ?? flag?.body ?? '')
    }
    if (action === 'add') {
      setAddTitle('')
      setAddDetail('')
      setAddMeasure('')
      setAddType('technique')
    }
  }

  function cancelAnnotation() {
    setActiveAnnot(null)
  }

  async function handleUpgrade(e) {
    e.preventDefault()
    if (upgradeState === 'sending') return
    if (!upgradeCode.trim()) { setUpgradeError('Enter your teacher access code.'); return }
    setUpgradeState('sending'); setUpgradeError('')
    const { data, error } = await supabase.functions
      .invoke('redeem-teacher-code', { body: { code: upgradeCode.trim() } })
      .catch(err => ({ data: null, error: err }))
    if (!error && data?.ok) {
      // Role changed in the DB — refresh the cached profile so this page unlocks.
      refreshProfile()
    } else {
      setUpgradeState('error')
      setUpgradeError(data?.error || error?.message || 'That teacher code is not valid.')
    }
  }

  // Non-teachers: offer the invite-code upgrade instead of just a dead end.
  if (profile && profile.role !== 'teacher') {
    return (
      <div className={styles.notTeacher}>
        <p className={styles.notTeacherIcon}>🎓</p>
        <h2>Teacher accounts only</h2>
        <p>This page is for teacher accounts. If you have a teacher access code, enter it below to upgrade.</p>
        <form onSubmit={handleUpgrade} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320, margin: '20px auto 0' }}>
          <input
            type="text"
            placeholder="Teacher access code"
            value={upgradeCode}
            onChange={e => setUpgradeCode(e.target.value)}
            autoComplete="off"
            style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--line, #e8e4dc)', background: 'var(--input-bg, #fff)', color: 'var(--text, #1a1710)', fontSize: '0.95rem' }}
          />
          {upgradeError && <p style={{ color: 'var(--score-bad, #b03030)', fontSize: '0.85rem', margin: 0 }}>{upgradeError}</p>}
          <button className={styles.backBtn} type="submit" disabled={upgradeState === 'sending'}>
            {upgradeState === 'sending' ? 'Checking…' : 'Upgrade to teacher'}
          </button>
        </form>
        <button
          onClick={() => nav('/home')}
          style={{ marginTop: 14, background: 'none', border: 'none', color: 'var(--text-muted, #8a8070)', cursor: 'pointer', fontSize: '0.9rem' }}
        >
          Go to Home
        </button>
      </div>
    )
  }

  const activeStudents  = relationships.filter(r => r.status === 'active')
  const pendingStudents = relationships.filter(r => r.status === 'pending')

  return (
    <div className={styles.page}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Teacher Studio</h1>
          <p className={styles.subtitle}>
            Review your students' practice sessions and guide their development.
          </p>
        </div>
        <div className={styles.statRow}>
          <div className={styles.stat}>
            <span className={styles.statNum}>{activeStudents.length}</span>
            <span className={styles.statLabel}>Students</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statNum}>{pendingStudents.length}</span>
            <span className={styles.statLabel}>Pending</span>
          </div>
        </div>
      </div>

      <div className={styles.layout}>
        {/* ── Left: student list + invite ── */}
        <aside className={styles.sidebar}>
          {/* Invite form */}
          <div className={styles.inviteCard}>
            <p className={styles.inviteTitle}>Add a student</p>
            <form className={styles.inviteForm} onSubmit={handleInvite}>
              <input
                className={styles.inviteInput}
                type="email"
                placeholder="student@email.com"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                required
              />
              <button className={styles.inviteBtn} type="submit" disabled={inviteLoading}>
                {inviteLoading ? '…' : 'Invite'}
              </button>
            </form>
            {inviteError   && <p className={styles.inviteError}>{inviteError}</p>}
            {inviteSuccess && <p className={styles.inviteOk}>{inviteSuccess}</p>}
          </div>

          {/* Student list */}
          {loading ? (
            <div className={styles.emptyState}>Loading…</div>
          ) : relationships.length === 0 ? (
            <div className={styles.emptyState}>
              No students yet. Invite someone above.
            </div>
          ) : (
            <div className={styles.studentList}>
              {activeStudents.length > 0 && (
                <>
                  <p className={styles.listLabel}>Active</p>
                  {activeStudents.map(rel => {
                    const s = rel.student
                    const isSelected = selectedStudent?.id === s?.id
                    return (
                      <button
                        key={rel.id}
                        className={`${styles.studentBtn} ${isSelected ? styles.studentBtnActive : ''}`}
                        onClick={() => selectStudent(s)}
                      >
                        <span className={styles.studentAvatar}>
                          {(s?.display_name ?? '?')[0].toUpperCase()}
                        </span>
                        <span className={styles.studentName}>{s?.display_name ?? 'Student'}</span>
                        <span className={styles.activeBadge}>active</span>
                      </button>
                    )
                  })}
                </>
              )}
              {pendingStudents.length > 0 && (
                <>
                  <p className={styles.listLabel} style={{ marginTop: 16 }}>Pending invite</p>
                  {pendingStudents.map(rel => {
                    const s = rel.student
                    return (
                      <div key={rel.id} className={styles.studentBtn} style={{ opacity: 0.65, cursor: 'default' }}>
                        <span className={styles.studentAvatar}>
                          {(s?.display_name ?? '?')[0].toUpperCase()}
                        </span>
                        <span className={styles.studentName}>{s?.display_name ?? 'Student'}</span>
                        <span className={styles.pendingBadge}>pending</span>
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          )}
        </aside>

        {/* ── Right: takes + flag review ── */}
        <main className={styles.main}>
          {!selectedStudent ? (
            <div className={styles.emptyMain}>
              <span className={styles.emptyMainIcon}>♩</span>
              <p>Select a student from the left to view their practice sessions.</p>
            </div>
          ) : (
            <>
              <div className={styles.takesHeader}>
                <h2 className={styles.takesTitle}>
                  {selectedStudent.display_name ?? 'Student'}'s sessions
                </h2>
              </div>

              {takesLoading ? (
                <div className={styles.emptyState}>Loading takes…</div>
              ) : studentTakes.length === 0 ? (
                <div className={styles.emptyState}>
                  This student has no completed analysis sessions yet.
                </div>
              ) : (
                <div className={styles.takeList}>
                  {studentTakes.map(take => {
                    const isOpen = selectedTake?.id === take.id
                    return (
                      <div key={take.id} className={`${styles.takeCard} ${isOpen ? styles.takeCardOpen : ''}`}>
                        <button
                          className={styles.takeCardHeader}
                          onClick={() => selectTake(take)}
                        >
                          <div className={styles.takeCardLeft}>
                            <span className={styles.takePiece}>{take.piece_title}</span>
                            <span className={styles.takeMeta}>
                              {take.piece_composer ?? ''}{take.instrument ? ` · ${take.instrument}` : ''}
                              {' · '}{timeAgo(take.created_at)}
                            </span>
                          </div>
                          <div className={styles.takeCardRight}>
                            {take.score != null && (
                              <span className={styles.takeScore} style={{ color: scoreColor(take.score) }}>
                                {take.score}
                              </span>
                            )}
                            <span className={styles.takeChevron}>{isOpen ? '▲' : '▼'}</span>
                          </div>
                        </button>

                        {isOpen && (
                          <div className={styles.flagsPanel}>
                            {(!take.flags || take.flags.length === 0) ? (
                              <p className={styles.noFlags}>No flags — clean performance.</p>
                            ) : (
                              <>
                                <p className={styles.flagsLabel}>AI flags · Click to annotate</p>
                                {take.flags.map((flag, i) => {
                                  const ann         = annotations[i]
                                  const isActive    = activeAnnot?.flagIndex === i
                                  const isLoading   = annotLoading[i]
                                  const actionEmoji = ann?.action === 'approve' ? '✓'
                                    : ann?.action === 'edit'    ? '✎'
                                    : ann?.action === 'reject'  ? '✗'
                                    : null

                                  return (
                                    <div key={i} className={`${styles.flagRow} ${ann ? styles.flagRowAnnotated : ''}`}>
                                      <div className={styles.flagRowMain}>
                                        <span className={styles.flagMeasure}>m.{flag.measure}</span>
                                        <span className={styles.flagType} data-type={flag.type}>
                                          {(flag.type ?? '').toUpperCase()}
                                        </span>
                                        <span className={styles.flagTitle}>{flag.title}</span>
                                        {ann && (
                                          <span className={`${styles.annBadge} ${styles[`annBadge_${ann.action}`]}`} title={ann.rejection_reason ?? ''}>
                                            {actionEmoji} {capitalize(ann.action)}
                                            {ann.rejection_reason && ` · ${ann.rejection_reason.replace(/_/g, ' ')}`}
                                          </span>
                                        )}
                                      </div>
                                      <p className={styles.flagDetail}>{flag.detail ?? flag.body}</p>

                                      {/* Annotation action buttons */}
                                      <div className={styles.annotBtns}>
                                        <button
                                          className={`${styles.annotBtn} ${styles.annotApprove} ${ann?.action === 'approve' ? styles.annotBtnActive : ''}`}
                                          title="Approve — flag is correct"
                                          disabled={isLoading}
                                          onClick={() => {
                                            if (ann?.action === 'approve') { deleteAnnotation(i); return }
                                            submitAnnotation(i, 'approve')
                                          }}
                                        >✓ Approve</button>

                                        <button
                                          className={`${styles.annotBtn} ${styles.annotEdit} ${ann?.action === 'edit' ? styles.annotBtnActive : ''}`}
                                          title="Edit — correct the flag text"
                                          disabled={isLoading}
                                          onClick={() => isActive && activeAnnot.action === 'edit' ? cancelAnnotation() : openAnnotation(i, 'edit', flag)}
                                        >✎ Edit</button>

                                        <button
                                          className={`${styles.annotBtn} ${styles.annotReject} ${ann?.action === 'reject' ? styles.annotBtnActive : ''}`}
                                          title="Reject — flag is wrong"
                                          disabled={isLoading}
                                          onClick={() => isActive && activeAnnot.action === 'reject' ? cancelAnnotation() : openAnnotation(i, 'reject', flag)}
                                        >✗ Reject</button>

                                        {ann && (
                                          <button
                                            className={`${styles.annotBtn} ${styles.annotClear}`}
                                            title="Remove annotation"
                                            onClick={() => deleteAnnotation(i)}
                                          >Clear</button>
                                        )}
                                      </div>

                                      {/* Inline: reject reason */}
                                      {isActive && activeAnnot.action === 'reject' && (
                                        <div className={styles.inlineForm}>
                                          <p className={styles.inlineLabel}>Why is this flag wrong?</p>
                                          <div className={styles.reasonGrid}>
                                            {REJECTION_REASONS.map(r => (
                                              <button
                                                key={r.value}
                                                className={`${styles.reasonBtn} ${rejectReason === r.value ? styles.reasonBtnActive : ''}`}
                                                onClick={() => setRejectReason(r.value)}
                                              >
                                                {r.label}
                                              </button>
                                            ))}
                                          </div>
                                          <div className={styles.inlineActions}>
                                            <button
                                              className={styles.inlineSubmit}
                                              onClick={() => submitAnnotation(i, 'reject', { rejectionReason: rejectReason })}
                                              disabled={isLoading}
                                            >
                                              {isLoading ? 'Saving…' : 'Submit rejection'}
                                            </button>
                                            <button className={styles.inlineCancel} onClick={cancelAnnotation}>Cancel</button>
                                          </div>
                                        </div>
                                      )}

                                      {/* Inline: edit flag */}
                                      {isActive && activeAnnot.action === 'edit' && (
                                        <div className={styles.inlineForm}>
                                          <p className={styles.inlineLabel}>Corrected flag</p>
                                          <input
                                            className={styles.inlineInput}
                                            placeholder="Corrected title"
                                            value={editedTitle}
                                            onChange={e => setEditedTitle(e.target.value)}
                                          />
                                          <textarea
                                            className={styles.inlineTextarea}
                                            placeholder="Corrected detail / advice…"
                                            rows={3}
                                            value={editedDetail}
                                            onChange={e => setEditedDetail(e.target.value)}
                                          />
                                          <div className={styles.inlineActions}>
                                            <button
                                              className={styles.inlineSubmit}
                                              onClick={() => submitAnnotation(i, 'edit', {
                                                editedFlag: { ...flag, title: editedTitle, detail: editedDetail },
                                              })}
                                              disabled={isLoading || !editedTitle.trim()}
                                            >
                                              {isLoading ? 'Saving…' : 'Save correction'}
                                            </button>
                                            <button className={styles.inlineCancel} onClick={cancelAnnotation}>Cancel</button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}

                                {/* Add a flag the AI missed */}
                                {activeAnnot?.action === 'add' ? (
                                  <div className={styles.addFlagForm}>
                                    <p className={styles.inlineLabel}>Add a flag the AI missed</p>
                                    <div className={styles.addFlagRow}>
                                      <input
                                        className={styles.inlineInput}
                                        type="number"
                                        min="1"
                                        placeholder="Measure"
                                        value={addMeasure}
                                        onChange={e => setAddMeasure(e.target.value)}
                                        style={{ width: 80 }}
                                      />
                                      <select
                                        className={styles.inlineSelect}
                                        value={addType}
                                        onChange={e => setAddType(e.target.value)}
                                      >
                                        {['technique','intonation','rhythm','timing','dynamics','articulation','tone','phrasing'].map(t => (
                                          <option key={t} value={t}>{capitalize(t)}</option>
                                        ))}
                                      </select>
                                    </div>
                                    <input
                                      className={styles.inlineInput}
                                      placeholder="Flag title"
                                      value={addTitle}
                                      onChange={e => setAddTitle(e.target.value)}
                                    />
                                    <textarea
                                      className={styles.inlineTextarea}
                                      placeholder="Detailed feedback…"
                                      rows={3}
                                      value={addDetail}
                                      onChange={e => setAddDetail(e.target.value)}
                                    />
                                    <div className={styles.inlineActions}>
                                      <button
                                        className={styles.inlineSubmit}
                                        disabled={!addTitle.trim() || !addMeasure}
                                        onClick={() => submitAnnotation(null, 'add', {
                                          editedFlag: {
                                            measure: parseInt(addMeasure, 10),
                                            type: addType,
                                            title: addTitle,
                                            detail: addDetail,
                                          },
                                        })}
                                      >
                                        Add flag
                                      </button>
                                      <button className={styles.inlineCancel} onClick={cancelAnnotation}>Cancel</button>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    className={styles.addFlagBtn}
                                    onClick={() => openAnnotation(null, 'add', null)}
                                  >
                                    + Add flag the AI missed
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
