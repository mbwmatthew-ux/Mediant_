import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import AppShell from './components/AppShell'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Signup from './pages/Signup'
import Home from './pages/Home'
import Search from './pages/Search'
import Record from './pages/Record'
import Analysis from './pages/Analysis'
import FollowAlong from './pages/FollowAlong'
import Summary from './pages/Summary'
import Takes from './pages/Takes'
import Profile from './pages/Profile'

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/"       element={<Landing />} />
          <Route path="/login"  element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route element={<AppShell />}>
            <Route path="/home"     element={<Home />} />
            <Route path="/search"   element={<Search />} />
            <Route path="/record"   element={<Record />} />
            <Route path="/analysis" element={<Analysis />} />
            <Route path="/follow"   element={<FollowAlong />} />
            <Route path="/summary"  element={<Summary />} />
            <Route path="/takes"    element={<Takes />} />
            <Route path="/profile"  element={<Profile />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  )
}
