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

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Load existing session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(userFromSession(session))
      setLoading(false)
    })

    // Keep state in sync when the session changes (tab focus, token refresh, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(userFromSession(session))
    })

    return () => subscription.unsubscribe()
  }, [])

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
    <AuthContext.Provider value={{ user, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
