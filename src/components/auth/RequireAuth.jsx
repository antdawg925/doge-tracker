import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/authContext.js';
import BotLocked from './BotLocked.jsx';

function Checking() {
  return (
    <main className="auth-page">
      <p className="muted">Checking sign-in…</p>
    </main>
  );
}

/** Signed-in only; otherwise bounce to /login and come back after. */
export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Checking />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

/** Owner only (access keys now; Kraken / bot connection later); members land on Home. */
export function RequireOwner() {
  const { user, isOwner, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Checking />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!isOwner) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Trade Smart Bot tier (bot_access or owner); other members get the locked screen. */
export function RequireBot() {
  const { hasBotAccess } = useAuth();
  if (!hasBotAccess) return <BotLocked />;
  return <Outlet />;
}
