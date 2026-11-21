/**
 * Typed client for the HTTP contract. Every call is checked against `ApiRoutes`:
 * `api('GET /api/charts/:symbol', { params: { symbol: 'NQ' }, query: { tf: '15m' } })`.
 */
import type { ApiRoutes } from '@desk/contracts';

export type RouteKey = keyof ApiRoutes;
export type GetRoute = Extract<RouteKey, `GET ${string}`>;
export type Res<K extends RouteKey> = ApiRoutes[K]['res'];

type None = Record<never, never>;
type ParamNames<S extends string> = S extends `${string}:${infer P}/${infer R}` ? P | ParamNames<R> : S extends `${string}:${infer P}` ? P : never;
type ParamsOf<K extends string> = [ParamNames<K>] extends [never] ? None : { params: Record<ParamNames<K>, string> };
type BodyOf<K extends RouteKey> = ApiRoutes[K] extends { body: infer B } ? { body: B } : None;
type QueryOf<K extends RouteKey> = ApiRoutes[K] extends { query: infer Q } ? (None extends Q ? { query?: Q } : { query: Q }) : None;
export type Opts<K extends RouteKey> = ParamsOf<K> & BodyOf<K> & QueryOf<K>;
export type Args<K extends RouteKey> = None extends Opts<K> ? [opts?: Opts<K>] : [opts: Opts<K>];

interface LooseOpts { params?: Record<string, string>; query?: Record<string, string | number | undefined>; body?: unknown }

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True only in a build made with NEXT_PUBLIC_MOCK=1. The production build script refuses that flag. */
export const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

/** 401 state: the shell shows the passphrase screen while this is true. */
let needLogin = false;
const authSubs = new Set<() => void>();
export const auth = {
  get: (): boolean => needLogin,
  set(v: boolean): void {
    if (v === needLogin) return;
    needLogin = v;
    authSubs.forEach((f) => f());
  },
  subscribe(f: () => void): () => void {
    authSubs.add(f);
    return () => authSubs.delete(f);
  },
};

export function resolve(route: string, opts: LooseOpts = {}): { method: string; path: string; url: string } {
  const sp = route.indexOf(' ');
  const method = route.slice(0, sp);
  const path = route.slice(sp + 1).replace(/:([A-Za-z]+)/g, (_, k: string) => encodeURIComponent(opts.params?.[k] ?? ''));
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const q = qs.toString();
  return { method, path, url: q ? `${path}?${q}` : path };
}

async function errorMessage(r: Response): Promise<string> {
  try {
    const j: unknown = await r.clone().json();
    if (j && typeof j === 'object') {
      const o = j as Record<string, unknown>;
      const m = o.message ?? o.error;
      if (typeof m === 'string') return m;
    }
  } catch { /* not JSON */ }
  return `${r.status} ${r.statusText}`.trim();
}

export async function api<K extends RouteKey>(route: K, ...args: Args<K>): Promise<Res<K>> {
  const opts = (args[0] ?? {}) as LooseOpts;
  const { method, url } = resolve(route, opts);
  if (process.env.NEXT_PUBLIC_MOCK === '1') {
    const { mockApi } = await import('desk-mock');
    return (await mockApi(route, opts)) as Res<K>;
  }
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      credentials: 'include',
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Offline');
  }
  if (r.status === 401 && route !== 'POST /api/auth/login') {
    auth.set(true);
    throw new ApiError(401, 'Sign in');
  }
  if (!r.ok) throw new ApiError(r.status, await errorMessage(r));
  return (await r.json()) as Res<K>;
}
