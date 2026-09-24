import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/home', label: 'Desk', end: true },
  { to: '/scanner', label: 'Scanner' },
  { to: '/short-kings', label: 'Short Kings' },
  { to: '/alerts', label: 'Alerts' },
];

export default function AppLayout() {
  return (
    <div className="desk-shell">
      <header className="desk-nav">
        <NavLink to="/home" className="desk-nav__brand" end>
          <span className="desk-nav__mark" aria-hidden>
            TD
          </span>
          <span className="desk-nav__title">Trade Desk</span>
        </NavLink>
        <nav className="desk-nav__links" aria-label="Primary">
          {NAV.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `desk-nav__link${isActive ? ' is-active' : ''}`
              }
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
