'use client';
/**
 * SWR-style cache: memory first, mirrored to localStorage so the last-known state renders offline.
 * A view whose last fetch failed keeps its data and reports `staleSince` (the last good fetch).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api, ApiError, auth, MOCK, resolve, type Args, type GetRoute, type Opts, type Res } from './api';

export interface Entry<D> { data: D | undefined; t: number; failed: boolean; error: string | null; loading: boolean }
const EMPTY: Entry<never> = { data: undefined, t: 0, failed: false, error: null, loading: false };

const PREFIX = MOCK ? 'desk:m:' : 'desk:c:';
const mem = new Map<string, Entry<unknown>>();
const subs = new Map<string, Set<() => void>>();
const fetchers = new Map<string, () => Promise<void>>();
const inflight = new Map<string, Promise<void>>();

export const storage = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { window.localStorage.setItem(key, value); } catch { /* private mode or quota: memory cache still works */ }
  },
  remove(key: string): void {
    try { window.localStorage.removeItem(key); } catch { /* same */ }
  },
};

export function keyOf<K extends GetRoute>(route: K, ...args: Args<K>): string {
  return resolve(route, (args[0] ?? {}) as Parameters<typeof resolve>[1]).url;
}

function read(key: string): Entry<unknown> {
  const hit = mem.get(key);
  if (hit) return hit;
  let entry: Entry<unknown> = EMPTY;
  const raw = storage.get(PREFIX + key);
  if (raw) {
    try {
      const j = JSON.parse(raw) as { t: number; data: unknown };
      if (typeof j.t === 'number') entry = { data: j.data, t: j.t, failed: false, error: null, loading: false };
    } catch { storage.remove(PREFIX + key); }
  }
  mem.set(key, entry);
  return entry;
}
function write(key: string, entry: Entry<unknown>, persist: boolean): void {
  mem.set(key, entry);
  if (persist) storage.set(PREFIX + key, JSON.stringify({ t: entry.t, data: entry.data }));
  subs.get(key)?.forEach((f) => f());
}

/** Replace a cached response (mutation results, SSE events). */
export function setCache<K extends GetRoute>(key: string, data: Res<K>): void {
  write(key, { data, t: Date.now(), failed: false, error: null, loading: false }, true);
}
export function patchCache<K extends GetRoute>(key: string, fn: (prev: Res<K>) => Res<K>): void {
  const cur = read(key);
  if (cur.data !== undefined) write(key, { ...cur, data: fn(cur.data as Res<K>) }, true);
}
export function peek<K extends GetRoute>(key: string): Res<K> | undefined {
  return read(key).data as Res<K> | undefined;
}

export function revalidate(key: string): Promise<void> {
  const f = fetchers.get(key);
  if (!f) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  const p = f().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function revalidateAll(): void {
  for (const [key, set] of subs) if (set.size > 0) void revalidate(key);
}

export interface Live<D> {
  data: D | undefined;
  /** Epoch ms of the last good fetch when the latest attempt failed; null when fresh. */
  staleSince: number | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Cached GET. Pass `null` as the route to skip. */
export function useApi<K extends GetRoute>(route: K | null, opts?: Opts<K> | null, refreshMs = 0): Live<Res<K>> {
  const key = route ? resolve(route, (opts ?? {}) as Parameters<typeof resolve>[1]).url : '';
  const optsJson = JSON.stringify(opts ?? {});

  useEffect(() => {
    if (!route || !key) return;
    fetchers.set(key, async () => {
      const cur = read(key);
      write(key, { ...cur, loading: true }, false);
      try {
        const data = await api(route, ...([JSON.parse(optsJson)] as unknown as Args<K>));
        write(key, { data, t: Date.now(), failed: false, error: null, loading: false }, true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Request failed';
        const authErr = e instanceof ApiError && e.status === 401;
        write(key, { ...read(key), failed: !authErr, error: authErr ? null : msg, loading: false }, false);
      }
    });
    void revalidate(key);
    const onWake = () => { if (document.visibilityState === 'visible' && Date.now() - read(key).t > 15_000) void revalidate(key); };
    const onOnline = () => void revalidate(key);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onOnline);
    const timer = refreshMs > 0 ? window.setInterval(() => { if (document.visibilityState === 'visible') void revalidate(key); }, refreshMs) : 0;
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onOnline);
      if (timer) window.clearInterval(timer);
    };
  }, [route, key, optsJson, refreshMs]);

  const subscribe = useCallback((f: () => void) => {
    if (!key) return () => undefined;
    let set = subs.get(key);
    if (!set) subs.set(key, (set = new Set()));
    set.add(f);
    return () => { set.delete(f); };
  }, [key]);
  const entry = useSyncExternalStore(subscribe, () => (key ? read(key) : EMPTY), () => EMPTY) as Entry<Res<K>>;
  const refresh = useCallback(() => revalidate(key), [key]);

  return {
    data: entry.data,
    staleSince: entry.failed && entry.data !== undefined ? entry.t : null,
    error: entry.error,
    loading: entry.loading || (entry.data === undefined && !entry.error),
    refresh,
  };
}

export function useNeedLogin(): boolean {
  return useSyncExternalStore(auth.subscribe, auth.get, () => false);
}

/** A 1 Hz clock for countdowns and ages. 0 until mounted, so static HTML never bakes in a time. */
let nowValue = 0;
const tickSubs = new Set<() => void>();
let tickTimer = 0;
function subscribeTick(f: () => void): () => void {
  tickSubs.add(f);
  nowValue = Date.now();
  if (!tickTimer) {
    tickTimer = window.setInterval(() => { nowValue = Date.now(); tickSubs.forEach((s) => s()); }, 1000);
  }
  return () => {
    tickSubs.delete(f);
    if (tickSubs.size === 0) { window.clearInterval(tickTimer); tickTimer = 0; }
  };
}
export function useNow(): number {
  return useSyncExternalStore(subscribeTick, () => nowValue, () => 0);
}
