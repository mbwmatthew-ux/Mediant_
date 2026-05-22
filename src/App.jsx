import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
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
import PracticeLog from './pages/PracticeLog'

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/"       element={<Landing />} />
          <Route path="/login"  element={<Login />} />
          <Route path="/signup"        element={<Signup />} />
          <Route path="/confirm-email" element={<ConfirmEmail />} />
          <Route path="/pricing"       element={<Pricing />} />
          <Route element={<RequireSubscription><AppShell /></RequireSubscription>}>
            <Route path="/home"     element={<Home />} />
            <Route path="/search"   element={<Search />} />
            <Route path="/record"   element={<Record />} />
            <Route path="/analysis" element={<Analysis />} />
            <Route path="/summary"  element={<Summary />} />
            <Route path="/takes"    element={<Takes />} />
            <Route path="/coach"         element={<Coach />} />
            <Route path="/practice-log" element={<PracticeLog />} />
            <Route path="/profile"  element={<Profile />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  )
}
