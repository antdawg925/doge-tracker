import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import AuthProvider from './components/auth/AuthProvider.jsx';
import FeatureFlagsProvider from './components/FeatureFlagsProvider.jsx';
import { HomeGate, RequireAuth, RequireBot, RequireOwner } from './components/auth/RequireAuth.jsx';
import Home from './pages/Home';
import Research from './pages/Research';
import Positions from './pages/Positions';
import ScannerHub from './pages/ScannerHub';
import Plan from './pages/Plan';
import Alerts from './pages/Alerts';
import Login from './pages/Login';
import Signup from './pages/Signup';
import AdminLayout from './pages/admin/AdminLayout';
import AdminUsers from './pages/admin/AdminUsers';
import AdminBeta from './pages/admin/AdminBeta';
import AdminSystem from './pages/admin/AdminSystem';

/** Old Short Kings URLs → Scanner presets (?tab=my-shorts / ?mode=my-shorts keep My shorts). */
function ShortKingsRedirect() {
  const q = new URLSearchParams(window.location.search);
  const want = q.get('mode') || q.get('tab');
  return <Navigate to={`/scanner?mode=${want === 'my-shorts' ? 'my-shorts' : 'short-hunt'}`} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <FeatureFlagsProvider>
          <Routes>
            <Route element={<AppLayout />}>
              {/* Public */}
              <Route path="/" element={<HomeGate><Home /></HomeGate>} />
              <Route path="/home" element={<HomeGate><Home /></HomeGate>} />
              <Route path="/login" element={<Login />} />
              <Route path="/signup" element={<Signup />} />
              {/* Legacy route: the bot now lives at /bot. */}
              <Route path="/alerts" element={<Navigate to="/bot" replace />} />
              {/* Short Kings merged into Scanner presets */}
              <Route path="/short-kings" element={<ShortKingsRedirect />} />
              <Route path="/short-kings/*" element={<ShortKingsRedirect />} />
              <Route path="/shorts" element={<Navigate to="/scanner?mode=my-shorts" replace />} />
              {/* Signed in (free members) */}
              <Route element={<RequireAuth />}>
                <Route path="/research" element={<Research />} />
                <Route path="/positions" element={<Positions />} />
                <Route path="/scanner" element={<ScannerHub />} />
                {/* Plan: the publish surface; any signed-in user reads it (no bot gating) */}
                <Route path="/plan" element={<Plan />} />
                {/* Trade Smart Bot tier; others see the locked screen with Request access */}
                <Route element={<RequireBot />}>
                  <Route path="/bot" element={<Alerts />} />
                </Route>
              </Route>
              {/* Owner only */}
              <Route element={<RequireOwner />}>
                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<Navigate to="users" replace />} />
                  <Route path="users" element={<AdminUsers />} />
                  <Route path="beta" element={<AdminBeta />} />
                  <Route path="system" element={<AdminSystem />} />
                </Route>
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </FeatureFlagsProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
