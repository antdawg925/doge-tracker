import { createContext, useContext } from 'react';

export const AuthContext = createContext(null);

/**
 * { user, profile, role, isOwner, hasBotAccess, displayName, loading, configured,
 *   signIn(email, password), signUp({ email, password, displayName }), signOut(),
 *   redeemKey(code), refreshProfile() }
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
