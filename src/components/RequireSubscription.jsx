import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function RequireSubscription({ children }) {
  const { user, subscription } = useAuth()
  const location = useLocation()

  if (!user) return <Navigate to="/login" state={{ from: location }} replace />

  if (subscription?.status !== 'active') {
    return <Navigate to="/pricing" replace />
  }

  return children
}
