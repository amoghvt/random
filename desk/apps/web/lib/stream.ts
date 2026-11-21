'use client';
/** SSE subscription to /api/stream with backoff reconnect. Events patch the cache; nothing is computed here. */
import { useSyncExternalStore } from 'react';
import type { Notification, NowView, WatcherUpdate } from '@desk/contracts';
import { MOCK } from './api';
import { keyOf, patchCache, revalidate, setCache } from './store';

export type StreamState = 'off' | 'connecting' | 'live' | 'reconnecting';
let state: StreamState = 'off';
const subs = new Set<() => void>();
const setState = (s: StreamState): void => {
  if (s === state) return;
  state = s;
  subs.forEach((f) => f());
};
export function useStreamState(): StreamState {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state, () => 'off' as StreamState);
}

/** In-app toast for notifications that arrive while the app is open. */
let toast: Notification | null = null;
const toastSubs = new Set<() => void>();
export const toasts = {
  get: (): Notification | null => toast,
  set(n: Notification | null): void { toast = n; toastSubs.forEach((f) => f()); },
  subscribe(f: () => void): () => void { toastSubs.add(f); return () => toastSubs.delete(f); },
};
export function useToast(): Notification | null {
  return useSyncExternalStore(toasts.subscribe, toasts.get, () => null);
}

function parse<T>(e: MessageEvent<string>): T | null {
  try { return JSON.parse(e.data) as T; } catch { return null; }
}

let source: EventSource | null = null;
let retry = 0;
let timer = 0;

function connect(): void {
  if (source || typeof EventSource === 'undefined') return;
  setState(retry === 0 ? 'connecting' : 'reconnecting');
  const es = new EventSource('/api/stream', { withCredentials: true });
  source = es;
  const NOW = keyOf('GET /api/now');
  es.onopen = () => { retry = 0; setState('live'); };
  es.addEventListener('now', (e) => {
    const v = parse<NowView>(e as MessageEvent<string>);
    if (v) setCache<'GET /api/now'>(NOW, v);
  });
  es.addEventListener('update', (e) => {
    const u = parse<WatcherUpdate>(e as MessageEvent<string>);
    if (u) patchCache<'GET /api/now'>(NOW, (prev) => ({ ...prev, updates: [u, ...prev.updates.filter((x) => x.id !== u.id)].slice(0, 100) }));
  });
  es.addEventListener('call', () => { void revalidate(NOW); });
  es.addEventListener('notification', (e) => {
    const n = parse<Notification>(e as MessageEvent<string>);
    if (n && n.decision === 'sent') toasts.set(n);
    void revalidate(keyOf('GET /api/notifications'));
    void revalidate(keyOf('GET /api/positions'));
  });
  es.onerror = () => {
    // EventSource retries by itself only while CONNECTING; a closed stream (401, 5xx) needs a manual retry.
    es.close();
    source = null;
    setState('reconnecting');
    retry += 1;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      // The plain fetch surfaces a 401 to the login screen and refreshes the view if the stream gap dropped events.
      void revalidate(NOW);
      connect();
    }, Math.min(30_000, 1000 * 2 ** Math.min(retry, 5)));
  };
}

export function startStream(): () => void {
  if (MOCK) { setState('live'); return () => undefined; }
  connect();
  return () => {
    window.clearTimeout(timer);
    source?.close();
    source = null;
    setState('off');
  };
}
