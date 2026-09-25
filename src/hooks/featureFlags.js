import { createContext, useContext } from 'react';

export const FeatureFlagsContext = createContext({ flags: [], loading: true, refresh: () => {} });

export const FLAG_AUDIENCES = ['owner', 'bot', 'everyone'];

/** Pure check so it can be reused outside React. */
export function flagEnabled(flag, { isOwner, hasBotAccess }) {
  if (!flag) return false;
  if (isOwner) return true; // owner sees every flag (ship owner-only first)
  if (flag.enabled_for === 'everyone') return true;
  if (flag.enabled_for === 'bot') return Boolean(hasBotAccess);
  return false;
}

export function useFeatureFlags() {
  return useContext(FeatureFlagsContext);
}

/**
 * const showKraken = useFeature('kraken_panel');
 * true when the flag's audience (owner / bot / everyone) includes the current user.
 */
export function useFeature(key) {
  const { flags, access } = useContext(FeatureFlagsContext);
  return flagEnabled(
    flags.find((f) => f.key === key),
    access || {},
  );
}
