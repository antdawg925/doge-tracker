import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/authContext.js';

export default function Signup() {
  const { user, loading, configured, signUp } = useAuth();
  const [form, setForm] = useState({
    displayName: '',
    email: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!loading && user) return <Navigate to="/research" replace />;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (form.password.length < 8) {
      setError({ message: 'Password must be at least 8 characters.', field: 'password' });
      return;
    }
    setBusy(true);
    try {
      await signUp(form);
    } catch (err) {
      setError({ message: err.message || 'Signup failed.', field: err.field });
      setBusy(false);
    }
  };

  const invalid = (field) => (error?.field === field ? 'true' : undefined);

  return (
    <main className="auth-page">
      <form className="auth-card card" onSubmit={submit} noValidate>
        <p className="auth-card__kicker muted">Trade Smart</p>
        <h1>Create account</h1>
        <p className="auth-card__lede muted">
          Free account: Research, Scanner and Short Kings. Trade Smart Bot (Alerts) can be requested
          after you sign up.
        </p>
        <label className="field">
          Name
          <input
            autoComplete="name"
            value={form.displayName}
            onChange={set('displayName')}
            maxLength={60}
            required
          />
        </label>
        <label className="field">
          Email
          <input
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={set('email')}
            aria-invalid={invalid('email')}
            required
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set('password')}
            aria-invalid={invalid('password')}
            minLength={8}
            required
          />
          <span className="field__hint">At least 8 characters.</span>
        </label>

        {error ? (
          <p className="auth-card__error" role="alert">
            {error.message}
          </p>
        ) : null}

        <button
          type="submit"
          className="btn btn--primary auth-card__submit"
          disabled={
            busy || !configured || !form.displayName || !form.email || !form.password
          }
        >
          {busy ? 'Creating account…' : 'Create account'}
        </button>
        <p className="auth-card__alt muted">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
