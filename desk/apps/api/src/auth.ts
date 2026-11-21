import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from './env';

export const SESSION_COOKIE = 'desk_session';
export const SESSION_MS = 180 * 86_400_000;

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();
/** Constant-time string compare (hashing first removes the length side channel). */
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(sha(a), sha(b));

/** Cookie-signing key. Derived from the passphrase, so changing DESK_TOKEN signs every device out. */
export function sessionSecret(env: Pick<Env, 'DESK_TOKEN'>): string {
  return createHmac('sha256', env.DESK_TOKEN ?? randomBytes(32)).update('desk.session.v1').digest('hex');
}

/** No passphrase configured (never the case in production): the API is open. */
export const authDisabled = (env: Pick<Env, 'DESK_TOKEN'>): boolean => !env.DESK_TOKEN;

const PUBLIC_EXACT = new Set(['/api/health', '/api/auth/login']);
export function isPublicPath(path: string): boolean {
  return !path.startsWith('/api/') || PUBLIC_EXACT.has(path) || path.startsWith('/api/hooks/');
}

export function hasSession(req: FastifyRequest, now: number): boolean {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const r = req.unsignCookie(raw);
  return r.valid && r.value !== null && Number(r.value) > now;
}

export function setSession(req: FastifyRequest, reply: FastifyReply, env: Pick<Env, 'NODE_ENV'>, now: number): void {
  void reply.setCookie(SESSION_COOKIE, String(now + SESSION_MS), {
    signed: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_MS / 1000,
    // Always Secure in production. Over plain http on localhost Safari drops Secure cookies, so dev follows the request.
    secure: env.NODE_ENV === 'production' || req.protocol === 'https',
  });
}

/** In-process failed-attempt limiter keyed by client address. */
export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly clock: () => number, private readonly max = 5, private readonly windowMs = 15 * 60_000) {}

  /** Seconds until the key may try again; 0 when it is not blocked. */
  blockedFor(key: string): number {
    const h = this.hits.get(key);
    if (!h) return 0;
    const now = this.clock();
    if (h.resetAt <= now) { this.hits.delete(key); return 0; }
    return h.count >= this.max ? Math.ceil((h.resetAt - now) / 1000) : 0;
  }
  fail(key: string): void {
    const now = this.clock();
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
  }
  clear(key: string): void { this.hits.delete(key); }
}
