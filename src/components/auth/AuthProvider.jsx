import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthContext } from '../../hooks/authContext.js';
import { supabase, supabaseConfigured } from '../../lib/supabase.js';

/** Owner only (RLS lets the owner read every profile): members waiting for bot access. */
const fetchPendingCount = () =>
  supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .not('bot_access_requested_at', 'is', null)
    .eq('bot_access', false);

async function fetchProfile(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('id, email, display_name, role, bot_access, bot_access_requested_at')
    .eq('id', userId)
    .maybeSingle();
  return data ?? null;
}

/**
 * Session + profile for the whole app.
 * Tiers: signed-in member (Research / Scanner / Short Kings) → bot tier
 * (profiles.bot_access, granted by the owner: Alerts / DOGE plan) → owner (Admin).
 */
export default function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(supabaseConfigured);
  const [pendingRequests, setPendingRequests] = useState(0);
  const ownerId = profile?.role === 'owner' ? profile.id : null;

  const applyPending = useCallback(({ count }) => setPendingRequests(count ?? 0), []);
  const refreshPending = useCallback(() => {
    if (ownerId) return fetchPendingCount().then(applyPending);
    return Promise.resolve();
  }, [ownerId, applyPending]);

  // Owner: keep the Admin nav badge fresh (on sign-in and every 2 minutes).
  useEffect(() => {
    if (!ownerId) return undefined;
    fetchPendingCount().then(applyPending);
    const id = setInterval(() => fetchPendingCount().then(applyPending), 120000);
    return () => clearInterval(id);
  }, [ownerId, applyPending]);

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

  /**
   * Open email + password signup. Email confirmation is off in Supabase Auth, so
   * this returns a session right away; a DB trigger creates the member profile.
   */
  const signUp = useCallback(async ({ email, password, displayName }) => {
    if (!supabase) throw new Error('Sign-up is not configured.');
    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: { data: { display_name: displayName.trim().slice(0, 60) } },
    });
    if (error) {
      const err = new Error(
        /already registered|already exists/i.test(error.message)
          ? 'An account with that email already exists. Sign in instead.'
          : error.message,
      );
      if (/already/i.test(error.message)) err.field = 'email';
      else if (/password/i.test(error.message)) err.field = 'password';
      throw err;
    }
    // Existing-email signups can come back as a user with no identities and no session.
    if (!data.session) {
      const err = new Error('An account with that email already exists. Sign in instead.');
      err.field = 'email';
      throw err;
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    const { data } = (await supabase?.auth.getSession()) ?? {};
    const uid = data?.session?.user?.id;
    setProfile(uid ? await fetchProfile(uid) : null);
  }, []);

  /** Ask the owner for Trade Smart Bot access (RPC only stamps bot_access_requested_at). */
  const requestBotAccess = useCallback(async () => {
    const { error } = await supabase.rpc('request_bot_access');
    if (error) throw new Error(error.message);
    await refreshProfile();
  }, [refreshProfile]);

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
  }, []);

  const value = useMemo(() => {
    const user = session?.user ?? null;
    const role = user ? profile?.role || 'member' : null;
    const isOwner = role === 'owner';
    return {
      configured: supabaseConfigured,
      loading,
      session,
      user,
      profile,
      role,
      isOwner,
      hasBotAccess: Boolean(user && (isOwner || profile?.bot_access)),
      displayName:
        profile?.display_name || user?.user_metadata?.display_name || user?.email || '',
      signIn,
      signUp,
      signOut,
      botRequestedAt: profile?.bot_access_requested_at ?? null,
      pendingRequests: isOwner ? pendingRequests : 0,
      refreshProfile,
      refreshPending,
      requestBotAccess,
    };
  }, [
    session,
    profile,
    loading,
    pendingRequests,
    signIn,
    signUp,
    signOut,
    refreshProfile,
    refreshPending,
    requestBotAccess,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
