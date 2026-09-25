import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/authContext.js';

export default function Login() {
  const { user, loading, configured, signIn } = useAuth();
  const location = useLocation();
  const from = location.state?.from === '/alerts' ? '/bot' : location.state?.from || '/research';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Redirect once the session lands in context (avoids racing RequireAuth).
  if (!loading && user) return <Navigate to={from} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err.message || 'Sign-in failed.');
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="auth-card card" onSubmit={submit} noValidate>
        <p className="auth-card__kicker muted">Trade Smart</p>
        <h1>Sign in</h1>
        {location.state?.from ? (
          <p className="auth-card__lede muted">Sign in to open that page.</p>
        ) : (
          <p className="auth-card__lede muted">Research, Scanner, Short Kings and My Bot need a free account.</p>
        )}

        {!configured ? (
          <p className="auth-card__error" role="alert">
            Sign-in isn’t configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see README).
          </p>
        ) : null}

        <label className="field">
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error ? (
          <p className="auth-card__error" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className="btn btn--primary auth-card__submit"
          disabled={busy || !configured || !email || !password}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="auth-card__alt muted">
          New here? <Link to="/signup">Create a free account</Link>
        </p>
      </form>
    </main>
  );
}
