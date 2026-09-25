import { useState } from 'react';
import { useAuth } from '../../hooks/authContext.js';
import { FLAG_AUDIENCES, useFeatureFlags } from '../../hooks/featureFlags.js';
import { supabase } from '../../lib/supabase.js';

const AUDIENCE_LABEL = { owner: 'Owner only', bot: 'Bot members', everyone: 'Everyone' };

/** Feature flags: choose who sees each feature (owner first, then bot tier, then everyone). */
export default function AdminBeta() {
  const { user } = useAuth();
  const { flags, loading, refresh } = useFeatureFlags();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const setAudience = async (flag, enabled_for) => {
    if (flag.enabled_for === enabled_for) return;
    setBusy(flag.key);
    setError('');
    const { error: err } = await supabase
      .from('feature_flags')
      .update({ enabled_for, updated_at: new Date().toISOString(), updated_by: user.id })
      .eq('key', flag.key);
    if (err) setError(err.message);
    await refresh();
    setBusy('');
  };

  return (
    <section className="admin-section">
      <div className="card admin-intro">
        <h2>Beta</h2>
        <p className="muted">
          Ship new features to yourself first, then to Trade Smart Bot members, then to everyone. In
          code: <span className="mono">useFeature(&apos;key&apos;)</span>. New flags are added with a
          migration.
        </p>
      </div>
      {error ? (
        <p className="auth-card__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="card admin-flags">
        {loading ? (
          <p className="muted">Loading flags…</p>
        ) : flags.length === 0 ? (
          <p className="muted">No feature flags yet.</p>
        ) : (
          flags.map((f) => (
            <div key={f.key} className="admin-flag">
              <div className="admin-flag__meta">
                <strong className="mono">{f.key}</strong>
                <span className="muted small">{f.description}</span>
              </div>
              <div className="admin-flag__seg" role="group" aria-label={`${f.key} audience`}>
                {FLAG_AUDIENCES.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={`admin-flag__opt${f.enabled_for === a ? ' is-active' : ''}`}
                    aria-pressed={f.enabled_for === a}
                    disabled={busy === f.key}
                    onClick={() => setAudience(f, a)}
                  >
                    {AUDIENCE_LABEL[a]}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
