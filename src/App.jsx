import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import AuthProvider from './components/auth/AuthProvider.jsx';
import FeatureFlagsProvider from './components/FeatureFlagsProvider.jsx';
import { RequireAuth, RequireBot, RequireOwner } from './components/auth/RequireAuth.jsx';
import Home from './pages/Home';
import Research from './pages/Research';
import Scanner from './pages/Scanner';
import ShortKings from './pages/ShortKings';
import Alerts from './pages/Alerts';
import Login from './pages/Login';
import Signup from './pages/Signup';
import AdminLayout from './pages/admin/AdminLayout';
import AdminUsers from './pages/admin/AdminUsers';
import AdminAccessKeys from './pages/admin/AdminAccessKeys';
import AdminBeta from './pages/admin/AdminBeta';
import AdminSystem from './pages/admin/AdminSystem';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <FeatureFlagsProvider>
          <Routes>
            <Route element={<AppLayout />}>
              {/* Public */}
              <Route path="/" element={<Home />} />
              <Route path="/home" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/signup" element={<Signup />} />
              {/* Signed in (free members) */}
              <Route element={<RequireAuth />}>
                <Route path="/research" element={<Research />} />
                <Route path="/scanner" element={<Scanner />} />
                <Route path="/short-kings" element={<ShortKings />} />
                {/* Trade Smart Bot tier; others see the locked screen with the key box */}
                <Route element={<RequireBot />}>
                  <Route path="/alerts" element={<Alerts />} />
                </Route>
              </Route>
              {/* Owner only */}
              <Route element={<RequireOwner />}>
                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<Navigate to="users" replace />} />
                  <Route path="users" element={<AdminUsers />} />
                  <Route path="keys" element={<AdminAccessKeys />} />
                  <Route path="beta" element={<AdminBeta />} />
                  <Route path="system" element={<AdminSystem />} />
                </Route>
              </Route>
              <Route path="/access-keys" element={<Navigate to="/admin/keys" replace />} />
              <Route path="/invites" element={<Navigate to="/admin/keys" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </FeatureFlagsProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
