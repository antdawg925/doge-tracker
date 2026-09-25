import { createContext, useContext } from 'react';

export const DogePlanContext = createContext(null);

/** Live DOGE plan state (plan, history, stop snapshot, alerts). Must be inside DogePlanProvider. */
export function useDogePlan() {
  const ctx = useContext(DogePlanContext);
  if (!ctx) throw new Error('useDogePlan must be used inside <DogePlanProvider>');
  return ctx;
}
