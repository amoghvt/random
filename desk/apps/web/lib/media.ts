'use client';
import { useSyncExternalStore } from 'react';

const QUERY = '(min-width: 1024px)';
const subscribe = (f: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener('change', f);
  return () => m.removeEventListener('change', f);
};
/** False in the static HTML and on phones; flips after hydration on a wide screen. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}
