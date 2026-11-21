/**
 * Thin fetch helpers. No proxy handling here: Node honours HTTPS_PROXY for global fetch when
 * NODE_USE_ENV_PROXY=1 is set (Node >= 22.21), which is how scripts/smoke.ts runs behind one.
 */
import type { FetchLike } from './types';

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, body: string) {
    super(`HTTP ${status} ${new URL(url).host}${body ? `: ${body.slice(0, 120).replace(/\s+/g, ' ')}` : ''}`);
  }
}

export interface HttpOpts { fetch?: FetchLike; headers?: Record<string, string>; method?: string; body?: unknown; timeoutMs?: number }

export async function httpText(url: string, o: HttpOpts = {}): Promise<string> {
  const f = o.fetch ?? (globalThis.fetch as FetchLike);
  const res = await f(url, {
    method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json, text/plain, */*', ...(o.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...o.headers },
    body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
    signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text);
  return text;
}

export async function httpJson<T>(url: string, o: HttpOpts = {}): Promise<T> {
  const text = await httpText(url, o);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${new URL(url).host}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
  }
}

/** Run `fn` over `xs` with bounded concurrency; failures are returned, not thrown. */
export async function mapLimit<A, B>(xs: A[], limit: number, fn: (x: A) => Promise<B>): Promise<Array<{ ok: true; value: B } | { ok: false; error: Error; input: A }>> {
  const out = new Array<{ ok: true; value: B } | { ok: false; error: Error; input: A }>(xs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < xs.length) {
      const i = next++;
      const x = xs[i] as A;
      try { out[i] = { ok: true, value: await fn(x) }; } catch (e) { out[i] = { ok: false, error: e instanceof Error ? e : new Error(String(e)), input: x }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

/** Throw only when every request failed, so one bad symbol does not mark the feed down. */
export function settle<A, B>(results: Awaited<ReturnType<typeof mapLimit<A, B>>>): B[] {
  const ok = results.filter((r): r is { ok: true; value: B } => r.ok).map((r) => r.value);
  const bad = results.find((r): r is { ok: false; error: Error; input: A } => !r.ok);
  if (ok.length === 0 && bad) throw bad.error;
  return ok;
}
