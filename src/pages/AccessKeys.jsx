import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../hooks/authContext.js';
import { supabase } from '../lib/supabase.js';
import { generateAccessKey, redeemLink } from '../lib/accessKeys.js';

const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

/** Keys + who redeemed them (owner can read all profiles and redemptions under RLS). */
const fetchKeys = async () => {
  const [keys, redemptions, profiles] = await Promise.all([
    supabase.from('access_keys').select('*').order('created_at', { ascending: false }),
    supabase.from('access_key_redemptions').select('code, user_id, redeemed_at'),
    supabase.from('profiles').select('id, email, display_name'),
  ]);
  const error = keys.error || redemptions.error || profiles.error;
  if (error) return { data: null, error };
  const names = new Map((profiles.data || []).map((p) => [p.id, p.display_name || p.email]));
  const byCode = new Map();
  for (const r of redemptions.data || []) {
    const list = byCode.get(r.code) || [];
    list.push(names.get(r.user_id) || 'deleted user');
    byCode.set(r.code, list);
  }
  return {
    data: keys.data.map((k) => ({ ...k, redeemedBy: byCode.get(k.code) || [] })),
    error: null,
  };
};

function status(inv) {
  if (!inv.active) return { label: 'Off', cls: 'badge--muted' };
  if (inv.uses >= inv.max_uses) return { label: 'Used up', cls: 'badge--warn' };
  return { label: 'Active', cls: 'badge--ok' };
}

/** Owner-only: mint Trade Smart Bot access keys, copy them, watch uses, switch them off. */
export default function AccessKeys() {
  const { user } = useAuth();
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState('');

  const apply = useCallback(({ data, error: err }) => {
    if (err) setError(err.message);
    else setKeys(data);
    setLoading(false);
  }, []);
  const load = useCallback(() => fetchKeys().then(apply), [apply]);

  useEffect(() => {
    fetchKeys().then(apply);
  }, [apply]);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    const uses = Math.max(1, Math.min(1000, Math.floor(Number(maxUses) || 1)));
    // Retry on the (very unlikely) primary-key collision.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error: err } = await supabase.from('access_keys').insert({
        code: generateAccessKey(),
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
      .from('access_keys')
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
    <main className="scanner keys-page">
      <div className="scanner__header card">
        <p className="scanner__kicker muted">Owner</p>
        <h1>Access keys</h1>
        <p className="scanner__subtitle muted">
          Anyone can create a free account (Research, Scanner, Short Kings). An access key unlocks
          Trade Smart Bot for that account: the Alerts tab with their own DOGE plan, staged stop,
          alerts and plan history. Each key works until it hits its max uses or you switch it off.
        </p>
      </div>

      <form className="card keys-form" onSubmit={create}>
        <label className="field keys-form__label">
          Label
          <input
            placeholder="Who is it for?"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
          />
        </label>
        <label className="field keys-form__uses">
          Max uses
          <input
            type="number"
            min={1}
            max={1000}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </label>
        <div className="field keys-form__role">
          Role
          <span className="keys-form__role-value">Member</span>
        </div>
        <button type="submit" className="btn btn--primary" disabled={creating}>
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {error ? (
        <p className="auth-card__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="card keys-list">
        {loading ? (
          <p className="muted">Loading access keys…</p>
        ) : keys.length === 0 ? (
          <p className="muted">No access keys yet.</p>
        ) : (
          <div className="keys-table-wrap">
            <table className="keys-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Label</th>
                  <th>Role</th>
                  <th>Uses</th>
                  <th>Status</th>
                  <th>Redeemed by</th>
                  <th>Last used</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {keys.map((inv) => {
                  const st = status(inv);
                  return (
                    <tr key={inv.code} className={inv.active ? '' : 'is-off'}>
                      <td className="mono keys-table__code">{inv.code}</td>
                      <td>{inv.label || <span className="muted">—</span>}</td>
                      <td className="keys-table__role">{inv.role}</td>
                      <td className="mono">
                        {inv.uses} / {inv.max_uses}
                      </td>
                      <td>
                        <span className={`badge ${st.cls}`}>{st.label}</span>
                      </td>
                      <td className="keys-table__who">
                        {inv.redeemedBy.length ? inv.redeemedBy.join(', ') : <span className="muted">—</span>}
                      </td>
                      <td className="muted">{fmtDate(inv.last_used_at)}</td>
                      <td className="keys-table__actions">
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => copy(inv.code, `c-${inv.code}`)}
                        >
                          {copied === `c-${inv.code}` ? 'Copied' : 'Copy key'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => copy(redeemLink(inv.code), `l-${inv.code}`)}
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
