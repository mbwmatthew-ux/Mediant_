import { Component } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { RecordModalProvider } from './context/RecordModalContext'

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false } }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(err, info) {
    if (typeof window.__SENTRY_INITIALIZED__ !== 'undefined') {
      import('@sentry/react').then(S => S.captureException(err, { extra: info })).catch(() => {})
    }
  }
  render() {
    if (this.state.hasError) return <div style={{ padding: 40, color: '#fff' }}>Something went wrong. Please refresh the page.</div>
    return this.props.children
  }
}
import AppShell from './components/AppShell'
import RequireSubscription from './components/RequireSubscription'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Signup from './pages/Signup'
import ConfirmEmail from './pages/ConfirmEmail'
import Pricing from './pages/Pricing'
import Home from './pages/Home'
import Analysis from './pages/Analysis'
import Sessions from './pages/Sessions'
import Reports from './pages/Reports'
import Settings from './pages/Settings'
import Privacy from './pages/Privacy'
import Terms from './pages/Terms'
import Contact from './pages/Contact'
import ResetPassword from './pages/ResetPassword'
import CookieBanner from './components/CookieBanner'
import { Analytics } from '@vercel/analytics/react'

export default function App() {
  return (
    <>
    <ErrorBoundary>
    <ThemeProvider>
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/"              element={<Landing />} />
          <Route path="/login"         element={<Login />} />
          <Route path="/signup"        element={<Signup />} />
          <Route path="/confirm-email" element={<ConfirmEmail />} />
          <Route path="/pricing"       element={<Pricing />} />
          <Route path="/privacy"       element={<Privacy />} />
          <Route path="/terms"         element={<Terms />} />
          <Route path="/contact"       element={<Contact />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/demo"          element={<Analysis demo />} />
          <Route element={<RequireSubscription><RecordModalProvider><AppShell /></RecordModalProvider></RequireSubscription>}>
            <Route path="/home"     element={<Home />} />
            <Route path="/record"   element={<Navigate to="/home" replace />} />
            <Route path="/analysis" element={<Analysis />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/reports"  element={<Reports />} />
            <Route path="/profile"  element={<Navigate to="/settings" replace />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <CookieBanner />
      </HashRouter>
    </AuthProvider>
    </ThemeProvider>
    </ErrorBoundary>
    <Analytics />
    </>
  )
}
