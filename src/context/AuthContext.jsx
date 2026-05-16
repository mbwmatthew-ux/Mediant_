import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

function userFromSession(session) {
  if (!session?.user) return null
  const { user } = session
  return {
    id:         user.id,
    email:      user.email,
    name:       user.user_metadata?.name       || '',
    instrument: user.user_metadata?.instrument || '',
  }
}

// SUBSCRIPTIONS DISABLED — run supabase migrations before re-enabling
// async function fetchSubscription(userId) {
//   const { data } = await supabase
//     .from('subscriptions')
//     .select('status, plan, current_period_end')
//     .eq('user_id', userId)
//     .single()
//   return data ?? { status: 'inactive', plan: null, current_period_end: null }
// }

export function AuthProvider({ children }) {
  const [user, setUser]   = useState(null)
  const [loading, setLoading] = useState(true)

  // Stub — always active until subscriptions table is set up
  const subscription = { status: 'active', plan: null }
  function refreshSubscription() {}

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(userFromSession(session))
      setLoading(false)
    })

    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(userFromSession(session))
    })

    return () => authSub.unsubscribe()
  }, [])

  // REALTIME SUBSCRIPTION LISTENER — re-enable with subscriptions table
  // useEffect(() => {
  //   if (!user) return
  //   const channel = supabase
  //     .channel(`sub-${user.id}`)
  //     .on('postgres_changes', {
  //       event: '*', schema: 'public', table: 'subscriptions',
  //       filter: `user_id=eq.${user.id}`,
  //     }, (payload) => setSubscription(payload.new))
  //     .subscribe()
  //   return () => { supabase.removeChannel(channel) }
  // }, [user?.id])

  async function signup(name, email, password, instrument) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name, instrument } },
    })
    if (error) return { ok: false, error: error.message }
    return { ok: true, user: userFromSession(data.session) }
  }

  async function login(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { ok: false, error: error.message }
    return { ok: true, user: userFromSession(data.session) }
  }

  async function logout() {
    await supabase.auth.signOut()
  }

  if (loading) return null

  return (
    <AuthContext.Provider value={{ user, subscription, login, signup, logout, refreshSubscription }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
