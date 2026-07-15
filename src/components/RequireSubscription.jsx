import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function RequireSubscription({ children }) {
  const { user } = useAuth()
  const location = useLocation()

  if (!user) return <Navigate to="/" replace />
  if (user.emailConfirmed === false) return <Navigate to="/confirm-email" replace />

  return children
}
