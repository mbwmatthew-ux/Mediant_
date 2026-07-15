import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

function getEmailRedirectUrl() {
  if (typeof window === 'undefined') return undefined
  return `${window.location.origin}/#/login`
}

function userFromSession(session) {
  if (!session?.user) return null
  const { user } = session
  return {
    id:             user.id,
    email:          user.email,
    emailConfirmed: !!user.email_confirmed_at,
    name:           user.user_metadata?.name           || '',
    instrument:     user.user_metadata?.instrument     || '',
    coaching_style: user.user_metadata?.coaching_style || 'Balanced',
    default_note:   user.user_metadata?.default_note   || '',
  }
}

async function fetchSubscription(userId) {
  const { data } = await supabase
    .from('subscriptions')
    .select('status, plan, current_period_end')
    .eq('user_id', userId)
    .maybeSingle()
  return data ?? { status: 'inactive', plan: null, current_period_end: null }
}

export function AuthProvider({ children }) {
  const [user,         setUser]         = useState(null)
  const [profile,      setProfile]      = useState(null)
  const [subscription, setSubscription] = useState({ status: 'inactive', plan: null })
  const [loading,      setLoading]      = useState(true)

  function refreshSubscription(userId) {
    const id = userId ?? user?.id
    if (id) fetchSubscription(id).then(setSubscription)
  }

  function refreshProfile(userId) {
    const id = userId ?? user?.id
    if (!id) { setProfile(null); return }
    supabase.from('profiles').select('role, display_name').eq('id', id).single()
      .then(({ data }) => setProfile(data ?? null))
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = userFromSession(session)
      setUser(u)
      if (u?.id) {
        fetchSubscription(u.id).then(setSubscription)
        supabase.from('profiles').select('role, display_name').eq('id', u.id).single()
          .then(({ data }) => setProfile(data ?? null))
      }
      setLoading(false)
    })

    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = userFromSession(session)
      setUser(u)
      if (u?.id) {
        fetchSubscription(u.id).then(setSubscription)
        supabase.from('profiles').select('role, display_name').eq('id', u.id).single()
          .then(({ data }) => setProfile(data ?? null))
      } else {
        setSubscription({ status: 'inactive', plan: null })
        setProfile(null)
      }
    })

    return () => authSub.unsubscribe()
  }, [])

  useEffect(() => {
    if (!user?.id) return
    const channel = supabase
      .channel(`sub-${user.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'subscriptions',
        filter: `user_id=eq.${user.id}`,
      }, payload => setSubscription(payload.new))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user?.id])

  async function signup(name, email, password, instrument) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name, instrument },
        emailRedirectTo: getEmailRedirectUrl(),
      },
    })
    if (error) return { ok: false, error: error.message }
    // Supabase returns an empty identities array when the email is already registered
    if (data.user?.identities?.length === 0) {
      return { ok: false, error: 'An account with this email already exists. Please log in instead.' }
    }
    return { ok: true, user: userFromSession(data.session) }
  }

  async function login(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { ok: false, error: error.message }
    return { ok: true, user: userFromSession(data.session) }
  }

  async function signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  }

  async function logout() {
    await supabase.auth.signOut()
  }

  if (loading) return (
    <div style={{
      alignItems: 'center',
      background: 'var(--bg)',
      display: 'flex',
      height: '100vh',
      justifyContent: 'center',
    }}>
      <span style={{ color: 'var(--accent)', fontSize: '1.1rem', opacity: 0.6 }}>
        Loading…
      </span>
    </div>
  )

  return (
    <AuthContext.Provider value={{ user, profile, subscription, login, signup, signInWithGoogle, logout, refreshSubscription, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
