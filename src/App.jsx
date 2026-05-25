import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import AppShell from './components/AppShell'
import RequireSubscription from './components/RequireSubscription'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Signup from './pages/Signup'
import ConfirmEmail from './pages/ConfirmEmail'
import Pricing from './pages/Pricing'
import Home from './pages/Home'
import Search from './pages/Search'
import Record from './pages/Record'
import Analysis from './pages/Analysis'
import Summary from './pages/Summary'
import Takes from './pages/Takes'
import Profile from './pages/Profile'
import Coach from './pages/Coach'
import ProgressFeedback from './pages/ProgressFeedback'
import Settings from './pages/Settings'
import Privacy from './pages/Privacy'
import Terms from './pages/Terms'
import Contact from './pages/Contact'

export default function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/"       element={<Landing />} />
          <Route path="/login"  element={<Login />} />
          <Route path="/signup"        element={<Signup />} />
          <Route path="/confirm-email" element={<ConfirmEmail />} />
          <Route path="/pricing"       element={<Pricing />} />
          <Route path="/privacy"       element={<Privacy />} />
          <Route path="/terms"         element={<Terms />} />
          <Route path="/contact"       element={<Contact />} />
          <Route element={<RequireSubscription><AppShell /></RequireSubscription>}>
            <Route path="/home"     element={<Home />} />
            <Route path="/search"   element={<Search />} />
            <Route path="/record"   element={<Record />} />
            <Route path="/analysis" element={<Analysis />} />
            <Route path="/summary"  element={<Summary />} />
            <Route path="/takes"    element={<Takes />} />
            <Route path="/coach"    element={<Coach />} />
            <Route path="/progress" element={<ProgressFeedback />} />
            <Route path="/profile"  element={<Navigate to="/settings" replace />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
    </ThemeProvider>
  )
}
