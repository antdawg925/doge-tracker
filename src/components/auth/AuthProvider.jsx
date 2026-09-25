import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthContext } from '../../hooks/authContext.js';
import { supabase, supabaseConfigured } from '../../lib/supabase.js';

async function fetchProfile(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('id, email, display_name, role')
    .eq('id', userId)
    .maybeSingle();
  return data ?? null;
}

/** Session + profile (role) for the whole app. */
export default function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(supabaseConfigured);

  useEffect(() => {
    if (!supabase) return undefined;
    let alive = true;
    const apply = async (s) => {
      const p = s?.user ? await fetchProfile(s.user.id) : null;
      if (!alive) return;
      setSession(s ?? null);
      setProfile(p);
      setLoading(false);
    };
    supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // Token refreshes keep the same user; don't refetch the profile for those.
      if (event === 'TOKEN_REFRESHED') {
        setSession(s);
        return;
      }
      // Defer out of the auth callback (supabase-js recommends no awaits inside it).
      setTimeout(() => apply(s), 0);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email, password) => {
    if (!supabase) throw new Error('Sign-in is not configured.');
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error) {
      throw new Error(
        /invalid login credentials/i.test(error.message)
          ? 'Wrong email or password.'
          : error.message,
      );
    }
  }, []);

  /** Invite-gated signup goes through the server (/api/signup), then signs in. */
  const signUp = useCallback(
    async ({ email, password, inviteCode, displayName }) => {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, inviteCode, displayName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const err = new Error(body.error || `Signup failed (HTTP ${res.status}).`);
        err.field = body.field;
        throw err;
      }
      await signIn(email, password);
    },
    [signIn],
  );

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
  }, []);

  const value = useMemo(() => {
    const user = session?.user ?? null;
    const role = user ? profile?.role || 'member' : null;
    return {
      configured: supabaseConfigured,
      loading,
      session,
      user,
      profile,
      role,
      isOwner: role === 'owner',
      displayName:
        profile?.display_name || user?.user_metadata?.display_name || user?.email || '',
      signIn,
      signUp,
      signOut,
    };
  }, [session, profile, loading, signIn, signUp, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
