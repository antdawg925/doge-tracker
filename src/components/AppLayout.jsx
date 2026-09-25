import { useMemo } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import DogePlanProvider from './DogePlanProvider.jsx';
import { useAuth } from '../hooks/authContext.js';
import { supabase } from '../lib/supabase.js';
import { createSupabasePlanBackend } from '../lib/planStoreSupabase.js';

const NAV = [
  { to: '/home', label: 'Home', end: true, match: ['/', '/home'] },
  { to: '/research', label: 'Research' },
  { to: '/scanner', label: 'Scanner' },
  { to: '/short-kings', label: 'Short Kings' },
  { to: '/alerts', label: 'Alerts' },
];
const OWNER_NAV = [{ to: '/admin', label: 'Admin' }];

function AccountMenu() {
  const { user, displayName, isOwner, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (loading) return null;
  if (!user) {
    if (pathname === '/login') return null;
    return (
      <div className="desk-nav__account">
        <Link to="/login" className="btn btn--primary desk-nav__signin">
          Sign in
        </Link>
      </div>
    );
  }
  return (
    <div className="desk-nav__account">
      <span className="desk-nav__user" title={user.email}>
        {displayName}
        {isOwner ? <span className="badge badge--owner">Owner</span> : null}
      </span>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={async () => {
          await signOut();
          navigate('/', { replace: true });
        }}
      >
        Sign out
      </button>
    </div>
  );
}

export default function AppLayout() {
  const { pathname } = useLocation();
  const { user, isOwner, hasBotAccess, pendingRequests } = useAuth();
  // DOGE plan storage + polling only for the Trade Smart Bot tier.
  const botUserId = hasBotAccess ? (user?.id ?? null) : null;
  const planBackend = useMemo(
    () => (botUserId && supabase ? createSupabasePlanBackend(supabase, botUserId) : null),
    [botUserId],
  );
  const links = isOwner ? [...NAV, ...OWNER_NAV] : NAV;

  return (
    <div className="desk-shell">
      <header className="desk-nav">
        <NavLink to="/" className="desk-nav__brand" end>
          <img
            className="desk-nav__mark-img"
            src="/favicon.svg"
            alt=""
            width={28}
            height={28}
            decoding="async"
          />
          <span className="desk-nav__title">Trade Smart</span>
        </NavLink>
        <nav className="desk-nav__links" aria-label="Primary">
          {links.map(({ to, label, end, match }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => {
                const active = match ? match.includes(pathname) : isActive;
                return `desk-nav__link${active ? ' is-active' : ''}`;
              }}
            >
              {label}
              {to === '/admin' && pendingRequests > 0 ? (
                <span className="desk-nav__count" title={`${pendingRequests} bot access request(s)`}>
                  {pendingRequests}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <AccountMenu />
      </header>
      {planBackend ? (
        // Bot tier: the user's DOGE plan (Supabase) polls on every tab so alerts keep checking.
        <DogePlanProvider key={botUserId} backend={planBackend}>
          <Outlet />
        </DogePlanProvider>
      ) : (
        <Outlet />
      )}
    </div>
  );
}
