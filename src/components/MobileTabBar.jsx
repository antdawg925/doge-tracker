import { useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/authContext.js';

/** Phones (<768px): fixed bottom tab bar + "More" sheet. Hidden on desktop (CSS). */
const I = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  research: 'M4 19V9m5 10V5m5 14v-7m5 7V8',
  scanner: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm5.5 12.5L21 21',
  shorts: 'M4 7l6 6 4-4 6 6m0 0v-5m0 5h-5',
  bot: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};
const Icon = ({ d }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const TABS = [
  { to: '/home', label: 'Home', icon: I.home, match: ['/', '/home'] },
  { to: '/research', label: 'Research', icon: I.research },
  { to: '/scanner', label: 'Scanner', icon: I.scanner },
  { to: '/short-kings', label: 'Shorts', icon: I.shorts },
  { to: '/bot', label: 'My Bot', icon: I.bot },
];

export default function MobileTabBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, displayName, isOwner, signOut, pendingRequests } = useAuth();
  const [open, setOpen] = useState(false);
  const moreActive = ['/positions', '/admin'].some((p) => pathname.startsWith(p));
  return (
    <>
      {open ? (
        <div className="msheet" role="dialog" aria-label="More" onClick={() => setOpen(false)}>
          <div className="msheet__panel" onClick={(e) => e.stopPropagation()}>
            <NavLink to="/positions" className="msheet__item" onClick={() => setOpen(false)}>Positions</NavLink>
            {isOwner ? (
              <NavLink to="/admin" className="msheet__item" onClick={() => setOpen(false)}>
                Admin {pendingRequests > 0 ? <span className="desk-nav__count">{pendingRequests}</span> : null}
              </NavLink>
            ) : null}
            <div className="msheet__account">
              {user ? (
                <>
                  <span className="msheet__user" title={user.email}>
                    {displayName} {isOwner ? <span className="badge badge--owner">Owner</span> : null}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost msheet__btn"
                    onClick={async () => {
                      await signOut();
                      navigate('/', { replace: true });
                    }}
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <Link to="/login" className="btn btn--primary msheet__btn" onClick={() => setOpen(false)}>Sign in</Link>
              )}
            </div>
          </div>
        </div>
      ) : null}
      <nav className="tabbar" aria-label="Primary (mobile)">
        {TABS.map((t) => {
          const active = t.match ? t.match.includes(pathname) : pathname.startsWith(t.to);
          return (
            <NavLink key={t.to} to={t.to} className={`tabbar__tab${active ? ' is-active' : ''}`} onClick={() => setOpen(false)}>
              <Icon d={t.icon} />
              <span>{t.label}</span>
            </NavLink>
          );
        })}
        <button type="button" className={`tabbar__tab${open || moreActive ? ' is-active' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon d={I.more} />
          <span>More</span>
          {isOwner && pendingRequests > 0 ? <span className="tabbar__dot" /> : null}
        </button>
      </nav>
    </>
  );
}
