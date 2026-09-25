import { useEffect, useState } from 'react';
import { authedFetch } from '../../lib/api.js';

const BUILD_COMMIT = import.meta.env.VITE_BUILD_COMMIT || 'unknown';
const BUILD_TIME = import.meta.env.VITE_BUILD_TIME || null;
const REPO = 'https://github.com/antdawg925/doge-tracker';

const fmt = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })
    : '—';

function Row({ label, children }) {
  return (
    <div className="admin-kv__row">
      <span className="muted">{label}</span>
      <span>{children ?? '—'}</span>
    </div>
  );
}

/** Backend status for the owner: counts, Supabase project, deploy, Kraken keys present, bot. */
export default function AdminSystem() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    authedFetch('/api/admin/system')
      .then(setInfo)
      .catch((err) => setError(err.message));
  }, []);

  const c = info?.counts;
  return (
    <section className="admin-section">
      {error ? (
        <p className="auth-card__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="admin-stats">
        {[
          ['Users', c?.users],
          ['Bot access', c?.botUsers],
          ['Pending requests', c?.pendingRequests],
          ['Feature flags', c?.flags],
        ].map(([label, n]) => (
          <div key={label} className="card admin-stat">
            <span className="muted small">{label}</span>
            <strong>{n ?? '…'}</strong>
          </div>
        ))}
      </div>
      <div className="admin-grid">
        <div className="card admin-kv">
          <h2>Supabase</h2>
          <Row label="Project ref">
            <span className="mono">{info?.supabase.ref}</span>
          </Row>
          <Row label="Region">{info?.supabase.region}</Row>
          <Row label="Owners">{c?.owners}</Row>
        </div>
        <div className="card admin-kv">
          <h2>Deploy</h2>
          <Row label="Commit">
            {BUILD_COMMIT !== 'unknown' ? (
              <a className="mono" href={`${REPO}/commit/${BUILD_COMMIT}`} target="_blank" rel="noreferrer">
                {BUILD_COMMIT}
              </a>
            ) : (
              'unknown'
            )}
          </Row>
          <Row label="Built">{fmt(BUILD_TIME)}</Row>
          <Row label="Environment">{info?.server.env}</Row>
          <Row label="Deployment">
            <span className="mono small">{info?.server.deploymentUrl}</span>
          </Row>
        </div>
        <div className="card admin-kv">
          <h2>Kraken</h2>
          <Row label="Keys configured on server">
            {info ? (
              <span className={`badge ${info.kraken.keysConfigured ? 'badge--ok' : 'badge--warn'}`}>
                {info.kraken.keysConfigured ? 'Yes' : 'No'}
              </span>
            ) : null}
          </Row>
          <Row label="Connection">Not connected yet</Row>
        </div>
        <div className="card admin-kv">
          <h2>Bot</h2>
          <Row label="Last run">{info ? (info.bot.lastRun ? fmt(info.bot.lastRun) : 'no runs yet') : null}</Row>
          <Row label="Users processed">{info?.bot.usersProcessed}</Row>
          <Row label="Errors (24h)">
            {info ? (
              <span className={`badge ${info.bot.errors24h ? 'badge--warn' : 'badge--ok'}`}>
                {info.bot.errors24h ?? '—'}
              </span>
            ) : null}
          </Row>
          <Row label="Runs (24h)">{info?.bot.runs24h}</Row>
          <Row label="Schedule">{info?.bot.schedule}</Row>
        </div>
      </div>
    </section>
  );
}
