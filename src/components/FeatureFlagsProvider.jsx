import { useCallback, useEffect, useMemo, useState } from 'react';
import { FeatureFlagsContext } from '../hooks/featureFlags.js';
import { useAuth } from '../hooks/authContext.js';
import { supabase } from '../lib/supabase.js';

const fetchFlags = () =>
  supabase
    ? supabase.from('feature_flags').select('key, description, enabled_for, updated_at').order('key')
    : Promise.resolve({ data: [], error: null });

/** Loads feature flags (RLS: signed-out visitors only get 'everyone' flags). */
export default function FeatureFlagsProvider({ children }) {
  const { user, isOwner, hasBotAccess, loading: authLoading } = useAuth();
  const [flags, setFlags] = useState([]);
  const [loading, setLoading] = useState(true);
  const userId = user?.id ?? null;

  const apply = useCallback(({ data }) => {
    setFlags(data || []);
    setLoading(false);
  }, []);
  const refresh = useCallback(() => fetchFlags().then(apply), [apply]);

  useEffect(() => {
    if (authLoading) return;
    fetchFlags().then(apply);
  }, [authLoading, userId, apply]);

  const value = useMemo(
    () => ({ flags, loading, refresh, access: { isOwner, hasBotAccess } }),
    [flags, loading, refresh, isOwner, hasBotAccess],
  );
  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
}
