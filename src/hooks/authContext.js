import { createContext, useContext } from 'react';

export const AuthContext = createContext(null);

/**
 * { user, profile, role, isOwner, displayName, loading, configured,
 *   signIn(email, password), signUp({...}), signOut() }
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
