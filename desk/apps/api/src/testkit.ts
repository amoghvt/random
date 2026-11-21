/** Shared wiring for the API tests: MemoryStore, in-process bus and scheduler, a recording push transport. */
import type { FastifyInstance } from 'fastify';
import type { PushSubscribeBody } from '@desk/contracts';
import { MemoryStore } from '@desk/db';
import { buildApp, type AppDeps } from './app';
import { MemoryBus } from './bus';
import { parseEnv, type Env } from './env';
import type { Log } from './log';
import { DeskPusher, type FetchLike, type PushPayload, type WebPushOptions, type WebPushTransport } from './push';
import { TimerScheduler } from './scheduler';

export const TEST_TOKEN = 'correct horse battery staple';
export const T0 = Date.parse('2026-11-16T14:30:00.000Z');

export interface FakeTransport {
  transport: WebPushTransport;
  sent: Array<{ endpoint: string; payload: PushPayload; opts: WebPushOptions }>;
  /** Endpoint -> status the fake push service answers with (default 201). */
  status: Map<string, number>;
}
export function fakeTransport(): FakeTransport {
  const f: FakeTransport = {
    sent: [], status: new Map(),
    transport: async (sub, payload, opts) => {
      const statusCode = f.status.get(sub.endpoint) ?? 201;
      if (statusCode < 300) f.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as PushPayload, opts });
      return { statusCode };
    },
  };
  return f;
}
export const fakeSub = (n: number): PushSubscribeBody => ({ endpoint: `https://push.invalid/sub/${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } });

export interface MemoryLog extends Log { lines: string[] }
export function memoryLog(): MemoryLog {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
}

export interface Kit {
  app: FastifyInstance; deps: AppDeps; push: FakeTransport; log: MemoryLog; telegram: string[];
  now: { t: number };
  /** Logs in and returns the Cookie header value. */
  login(): Promise<string>;
}

export function kit(envOver: Record<string, string> = {}, depsOver: Partial<AppDeps> = {}): Kit {
  const env: Env = parseEnv({ NODE_ENV: 'test', DESK_TOKEN: TEST_TOKEN, ...envOver });
  const now = { t: T0 };
  const clock = (): number => now.t;
  const log = memoryLog();
  const push = fakeTransport();
  const telegram: string[] = [];
  const fetchFake: FetchLike = async (url, init) => { telegram.push(`${url} ${init.body}`); return { ok: true, status: 200 }; };
  const store = depsOver.store ?? new MemoryStore();
  const bus = depsOver.bus ?? new MemoryBus();
  const deps: AppDeps = {
    env, clock, store, bus,
    push: new DeskPusher({ store, bus, env, clock, log, transport: push.transport, fetch: fetchFake }),
    scheduler: new TimerScheduler({ store, clock, log }),
    ...depsOver,
  };
  const app = buildApp(deps);
  const login = async (): Promise<string> => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TEST_TOKEN } });
    const c = r.cookies[0];
    if (r.statusCode !== 200 || !c) throw new Error(`login failed: ${r.statusCode} ${r.body}`);
    return `${c.name}=${c.value}`;
  };
  return { app, deps, push, log, telegram, now, login };
}
