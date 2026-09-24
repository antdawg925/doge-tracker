import { NavLink, Outlet, useLocation } from 'react-router-dom';

const NAV = [
  { to: '/home', label: 'Home', end: true, match: ['/', '/home'] },
  { to: '/research', label: 'Research' },
  { to: '/scanner', label: 'Scanner' },
  { to: '/short-kings', label: 'Short Kings' },
  { to: '/alerts', label: 'Alerts' },
];

export default function AppLayout() {
  const { pathname } = useLocation();

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
          {NAV.map(({ to, label, end, match }) => (
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
            </NavLink>
          ))}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
