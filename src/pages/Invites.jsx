import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../hooks/authContext.js';
import { supabase } from '../lib/supabase.js';
import { generateInviteCode, signupLink } from '../lib/invites.js';

const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

const fetchInvites = () =>
  supabase.from('invites').select('*').order('created_at', { ascending: false });

function status(inv) {
  if (!inv.active) return { label: 'Off', cls: 'badge--muted' };
  if (inv.uses >= inv.max_uses) return { label: 'Used up', cls: 'badge--warn' };
  return { label: 'Active', cls: 'badge--ok' };
}

/** Owner-only: mint member invite codes, copy them, watch uses, switch them off. */
export default function Invites() {
  const { user } = useAuth();
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState('');

  const apply = useCallback(({ data, error: err }) => {
    if (err) setError(err.message);
    else setInvites(data);
    setLoading(false);
  }, []);
  const load = useCallback(() => fetchInvites().then(apply), [apply]);

  useEffect(() => {
    fetchInvites().then(apply);
  }, [apply]);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    const uses = Math.max(1, Math.min(1000, Math.floor(Number(maxUses) || 1)));
    // Retry on the (very unlikely) primary-key collision.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error: err } = await supabase.from('invites').insert({
        code: generateInviteCode(),
        label: label.trim() || null,
        role: 'member',
        max_uses: uses,
        created_by: user.id,
      });
      if (!err) {
        setLabel('');
        setMaxUses(1);
        break;
      }
      if (err.code !== '23505' || attempt === 2) {
        setError(err.message);
        break;
      }
    }
    setCreating(false);
    load();
  };

  const toggle = async (inv) => {
    setError('');
    const { error: err } = await supabase
      .from('invites')
      .update({ active: !inv.active })
      .eq('code', inv.code);
    if (err) setError(err.message);
    load();
  };

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? '' : c)), 1500);
    } catch {
      window.prompt('Copy this:', text);
    }
  };

  return (
    <main className="scanner invites-page">
      <div className="scanner__header card">
        <p className="scanner__kicker muted">Owner</p>
        <h1>Invites</h1>
        <p className="scanner__subtitle muted">
          Accounts are invite-only. Each code creates member accounts until it hits its max uses or
          you switch it off. Members get Research, Scanner, Short Kings and their own DOGE plan.
        </p>
      </div>

      <form className="card invites-form" onSubmit={create}>
        <label className="field invites-form__label">
          Label
          <input
            placeholder="Who is it for?"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
          />
        </label>
        <label className="field invites-form__uses">
          Max uses
          <input
            type="number"
            min={1}
            max={1000}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </label>
        <div className="field invites-form__role">
          Role
          <span className="invites-form__role-value">Member</span>
        </div>
        <button type="submit" className="btn btn--primary" disabled={creating}>
          {creating ? 'Creating…' : 'Create code'}
        </button>
      </form>

      {error ? (
        <p className="auth-card__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="card invites-list">
        {loading ? (
          <p className="muted">Loading invites…</p>
        ) : invites.length === 0 ? (
          <p className="muted">No invite codes yet.</p>
        ) : (
          <div className="invites-table-wrap">
            <table className="invites-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Label</th>
                  <th>Role</th>
                  <th>Uses</th>
                  <th>Status</th>
                  <th>Last used</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => {
                  const st = status(inv);
                  return (
                    <tr key={inv.code} className={inv.active ? '' : 'is-off'}>
                      <td className="mono invites-table__code">{inv.code}</td>
                      <td>{inv.label || <span className="muted">—</span>}</td>
                      <td className="invites-table__role">{inv.role}</td>
                      <td className="mono">
                        {inv.uses} / {inv.max_uses}
                      </td>
                      <td>
                        <span className={`badge ${st.cls}`}>{st.label}</span>
                      </td>
                      <td className="muted">{fmtDate(inv.last_used_at)}</td>
                      <td className="invites-table__actions">
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => copy(inv.code, `c-${inv.code}`)}
                        >
                          {copied === `c-${inv.code}` ? 'Copied' : 'Copy code'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => copy(signupLink(inv.code), `l-${inv.code}`)}
                        >
                          {copied === `l-${inv.code}` ? 'Copied' : 'Copy link'}
                        </button>
                        <button type="button" className="btn btn--ghost" onClick={() => toggle(inv)}>
                          {inv.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
