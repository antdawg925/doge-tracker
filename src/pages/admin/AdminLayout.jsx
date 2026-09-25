import { NavLink, Outlet } from 'react-router-dom';

const TABS = [
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/beta', label: 'Beta' },
  { to: '/admin/system', label: 'System' },
];

/** Owner-only area (route guarded by RequireOwner; every /api/admin call re-checks the role). */
export default function AdminLayout() {
  return (
    <main className="scanner admin-page">
      <div className="scanner__header card admin-header">
        <div>
          <p className="scanner__kicker muted">Owner</p>
          <h1>Admin</h1>
        </div>
        <nav className="admin-tabs" aria-label="Admin sections">
          {TABS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `admin-tabs__link${isActive ? ' is-active' : ''}`}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </main>
  );
}
