import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import AuthProvider from './components/auth/AuthProvider.jsx';
import { RequireAuth, RequireOwner } from './components/auth/RequireAuth.jsx';
import Home from './pages/Home';
import Research from './pages/Research';
import Scanner from './pages/Scanner';
import ShortKings from './pages/ShortKings';
import Alerts from './pages/Alerts';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Invites from './pages/Invites';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<AppLayout />}>
            {/* Public */}
            <Route path="/" element={<Home />} />
            <Route path="/home" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            {/* Signed-in (owner + members) */}
            <Route element={<RequireAuth />}>
              <Route path="/research" element={<Research />} />
              <Route path="/scanner" element={<Scanner />} />
              <Route path="/short-kings" element={<ShortKings />} />
              <Route path="/alerts" element={<Alerts />} />
            </Route>
            {/* Owner only */}
            <Route element={<RequireOwner />}>
              <Route path="/invites" element={<Invites />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
