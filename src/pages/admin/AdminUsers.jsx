import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../hooks/authContext.js';
import { authedFetch } from '../../lib/api.js';

const fmt = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

const fetchUsers = () => authedFetch('/api/admin/users');

function DeleteDialog({ user, onCancel, onDeleted }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = typed.trim().toLowerCase() === String(user.email).toLowerCase();

  const submit = async (e) => {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError('');
    try {
      await authedFetch(`/api/admin/users/${user.id}`, {
        method: 'DELETE',
        body: { confirmEmail: typed.trim() },
      });
      onDeleted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="del-title">
      <form className="admin-modal__card card" onSubmit={submit}>
        <h2 id="del-title">Delete account?</h2>
        <p className="muted">
          This permanently deletes <strong>{user.displayName || user.email}</strong> and all of their
          data (DOGE plan, history, alerts). It can’t be undone.
        </p>
        <label className="field">
          Type <span className="mono admin-modal__email">{user.email}</span> to confirm
          <input
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        {error ? (
          <p className="auth-card__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="admin-modal__actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn--danger" disabled={!matches || busy}>
            {busy ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** All accounts: tier, sign-in activity, grant / revoke bot access, delete. */
export default function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const apply = useCallback((p) => {
    p.then((d) => {
      setUsers(d.users);
      setError('');
    }).catch((err) => setError(err.message));
  }, []);
  const load = useCallback(() => apply(fetchUsers()), [apply]);

  useEffect(() => {
    apply(fetchUsers());
  }, [apply]);

  const setBot = async (u, bot_access) => {
    setBusyId(u.id);
    setError('');
    try {
      await authedFetch(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { bot_access } });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const botCount = users?.filter((u) => u.botAccess).length ?? 0;

  return (
    <section className="admin-section">
      <div className="card admin-intro">
        <h2>Users</h2>
        <p className="muted">
          {users ? `${users.length} accounts · ${botCount} with Trade Smart Bot. ` : 'Loading accounts… '}
          Passwords are never visible here: Supabase stores only salted hashes.
        </p>
      </div>
      {error ? (
        <p className="auth-card__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="card">
        {!users ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="keys-table-wrap">
            <table className="keys-table admin-users">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Signed up</th>
                  <th>Last sign-in</th>
                  <th>Role</th>
                  <th>Bot</th>
                  <th>Key</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === me?.id;
                  const owner = u.role === 'owner';
                  return (
                    <tr key={u.id}>
                      <td>
                        {u.displayName || <span className="muted">—</span>}
                        {self ? <span className="badge admin-users__you">You</span> : null}
                      </td>
                      <td className="admin-users__email">{u.email}</td>
                      <td className="muted">{fmt(u.createdAt)}</td>
                      <td className="muted">{fmt(u.lastSignInAt)}</td>
                      <td>
                        <span className={`badge${owner ? ' badge--owner' : ''}`}>{u.role}</span>
                      </td>
                      <td>
                        <span className={`badge ${u.botAccess ? 'badge--ok' : 'badge--muted'}`}>
                          {u.botAccess ? 'On' : 'Off'}
                        </span>
                      </td>
                      <td className="mono admin-users__keys">
                        {u.keys.length ? u.keys.join(', ') : <span className="muted">—</span>}
                      </td>
                      <td className="keys-table__actions">
                        {self || owner ? (
                          <span className="muted small">Owner</span>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn--ghost"
                              disabled={busyId === u.id}
                              onClick={() => setBot(u, !u.botAccess)}
                            >
                              {u.botAccess ? 'Revoke bot' : 'Grant bot'}
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--ghost-danger"
                              onClick={() => setDeleting(u)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {deleting ? (
        <DeleteDialog
          user={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            load();
          }}
        />
      ) : null}
    </section>
  );
}
