import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KV, type Notification, type Profile } from '@desk/contracts';
import { createDeps } from './deps';
import { buildApp } from './app';
import { parseEnv } from './env';
import { seedProfile } from './profile';
import { VAPID_KV } from './push';
import { fakeSub, fakeTransport, kit, T0, TEST_TOKEN, type Kit } from './testkit';
import { DeskPusher } from './push';

let k: Kit;
afterEach(async () => { await k?.app.close(); });
const json = <T>(r: { body: string }): T => JSON.parse(r.body) as T;

describe('acceptance', () => {
  it('boots with zero env vars on MemoryStore, serves health, accepts a login, stores a subscription and delivers a test push', async () => {
    const env = parseEnv({});
    expect(env.DATABASE_URL).toBeUndefined();
    const push = fakeTransport();
    const deps = createDeps({ ...env, LOG_LEVEL: 'silent' });
    deps.push = new DeskPusher({ store: deps.store, bus: deps.bus, env, clock: deps.clock, transport: push.transport });
    const app = buildApp(deps);
    try {
      expect(await seedProfile(deps.store)).toBe(true);
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(json(health)).toEqual({ ok: true, version: '0.1.0', lastLoop: null, killSwitch: false });

      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'anything' } });
      expect(login.statusCode).toBe(200);
      const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;

      const key = json<{ publicKey: string }>(await app.inject({ method: 'GET', url: '/api/push/key', headers: { cookie } }));
      expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
      expect((await deps.store.kvGet<{ publicKey: string }>(VAPID_KV))!.publicKey).toBe(key.publicKey);

      const sub = await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: fakeSub(1) });
      expect(json(sub)).toEqual({ ok: true });
      expect(await deps.store.kvGet(KV.pushSubs)).toHaveLength(1);

      const test = await app.inject({ method: 'POST', url: '/api/push/test', headers: { cookie } });
      expect(json(test)).toEqual({ ok: true, sent: 1 });
      expect(push.sent).toHaveLength(1);
      expect(push.sent[0]!.endpoint).toBe(fakeSub(1).endpoint);
      expect(Object.keys(push.sent[0]!.payload).sort()).toEqual(['body', 'class', 'tag', 'title', 'url']);
      expect(push.sent[0]!.opts.vapid.publicKey).toBe(key.publicKey);

      expect(json<Profile>(await app.inject({ method: 'GET', url: '/api/profile', headers: { cookie } })).trader).toBe('Amogh');
    } finally {
      await app.close();
      await deps.store.close();
    }
  });
});

describe('auth', () => {
  it('requires the session cookie on every /api route except health, login and hooks', async () => {
    k = kit();
    for (const [method, url] of [['GET', '/api/profile'], ['GET', '/api/notifications'], ['GET', '/api/admin/kill'], ['POST', '/api/admin/kill'], ['GET', '/api/push/key'], ['POST', '/api/push/test'], ['GET', '/api/stream'], ['POST', '/api/import/tradingview-csv'], ['GET', '/api/not-a-route']] as const) {
      const r = await k.app.inject({ method, url });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await k.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    // Hooks authenticate with their own secret; without one configured the hook is off, not open.
    expect((await k.app.inject({ method: 'POST', url: '/api/hooks/tradingview', payload: { secret: 'x', symbol: 'NQ', price: 1 } })).statusCode).toBe(503);
  });

  it('accepts the passphrase, sets an httpOnly signed SameSite=Lax cookie, and the cookie opens the API', async () => {
    k = kit();
    const bad = await k.app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.cookies).toHaveLength(0);
    const ok = await k.app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TEST_TOKEN } });
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toEqual({ ok: true });
    const c = ok.cookies[0]!;
    expect(c).toMatchObject({ name: 'desk_session', httpOnly: true, sameSite: 'Lax', path: '/' });
    const cookie = `${c.name}=${c.value}`;
    expect((await k.app.inject({ method: 'GET', url: '/api/admin/kill', headers: { cookie } })).statusCode).toBe(200);
    // Tampered and expired cookies are refused.
    expect((await k.app.inject({ method: 'GET', url: '/api/admin/kill', headers: { cookie: `${c.name}=${String(T0 * 2)}.forged` } })).statusCode).toBe(401);
    k.now.t = T0 + 181 * 86_400_000;
    expect((await k.app.inject({ method: 'GET', url: '/api/admin/kill', headers: { cookie } })).statusCode).toBe(401);
  });

  it('marks the cookie Secure in production and refuses to start there without DESK_TOKEN', async () => {
    k = kit({ NODE_ENV: 'production', LOG_LEVEL: 'silent' });
    const ok = await k.app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TEST_TOKEN } });
    expect(ok.cookies[0]!.secure).toBe(true);
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/DESK_TOKEN is required in production/);
    expect(() => parseEnv({ NODE_ENV: 'production', DESK_TOKEN: 'short' })).toThrow(/at least 12/);
  });

  it('rate-limits failed logins per address and recovers after the window', async () => {
    k = kit();
    const attempt = (token: string) => k.app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } });
    for (let i = 0; i < 5; i++) expect((await attempt('wrong')).statusCode).toBe(401);
    const blocked = await attempt(TEST_TOKEN);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    k.now.t += 15 * 60_000 + 1;
    expect((await attempt(TEST_TOKEN)).statusCode).toBe(200);
  });
});

describe('kill switch', () => {
  it('round-trips through the API and makes the scheduler skip every job, saying so in the log', async () => {
    k = kit();
    const cookie = await k.login();
    let runs = 0;
    k.deps.scheduler.every('loop', 60_000, () => { runs++; });
    expect((await k.deps.scheduler.runNow('loop')).status).toBe('ok');
    expect(runs).toBe(1);

    expect(json(await k.app.inject({ method: 'GET', url: '/api/admin/kill', headers: { cookie } }))).toEqual({ killSwitch: false });
    expect(json(await k.app.inject({ method: 'POST', url: '/api/admin/kill', headers: { cookie }, payload: { on: true } }))).toEqual({ killSwitch: true });
    expect(await k.deps.store.kvGet(KV.killSwitch)).toBe(true);
    expect(json<{ killSwitch: boolean }>(await k.app.inject({ method: 'GET', url: '/api/health' })).killSwitch).toBe(true);

    expect((await k.deps.scheduler.runNow('loop')).status).toBe('skipped_kill');
    expect(runs).toBe(1);
    expect(k.log.lines).toContain('warn scheduler: loop skipped, kill switch is on');

    expect(json(await k.app.inject({ method: 'POST', url: '/api/admin/kill', headers: { cookie }, payload: { on: false } }))).toEqual({ killSwitch: false });
    expect((await k.deps.scheduler.runNow('loop')).status).toBe('ok');
    expect(runs).toBe(2);
    expect((await k.app.inject({ method: 'POST', url: '/api/admin/kill', headers: { cookie }, payload: { on: 'yes' } })).statusCode).toBe(400);
  });
});

describe('push', () => {
  it('stores subscriptions once per endpoint, sends the test push to each, and prunes 404/410', async () => {
    k = kit();
    const cookie = await k.login();
    for (const n of [1, 2, 3, 1]) expect((await k.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: fakeSub(n) })).statusCode).toBe(200);
    expect(await k.deps.store.kvGet(KV.pushSubs)).toHaveLength(3);
    k.push.status.set(fakeSub(2).endpoint, 410);
    k.push.status.set(fakeSub(3).endpoint, 404);
    expect(json(await k.app.inject({ method: 'POST', url: '/api/push/test', headers: { cookie } }))).toEqual({ ok: true, sent: 1 });
    expect(k.push.sent.map((s) => s.endpoint)).toEqual([fakeSub(1).endpoint]);
    expect(k.push.sent[0]!.payload).toMatchObject({ title: 'Desk: test push', url: '/', class: 'P2' });
    expect((await k.deps.store.kvGet<Array<{ endpoint: string }>>(KV.pushSubs))!.map((s) => s.endpoint)).toEqual([fakeSub(1).endpoint]);
    expect((await k.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: { endpoint: 'not a url', keys: {} } })).statusCode).toBe(400);
  });

  it('reports sent 0 when nothing is subscribed', async () => {
    k = kit();
    const cookie = await k.login();
    expect(json(await k.app.inject({ method: 'POST', url: '/api/push/test', headers: { cookie } }))).toEqual({ ok: false, sent: 0 });
  });
});

describe('notifications', () => {
  const synthetic = (id: string, minutesAgo: number, over: Partial<Notification> = {}): Notification => ({
    id, class: 'P1', reason: 'synthetic', instrument: 'NQ', lines: ['synthetic line 1', 'synthetic line 2'], deepLink: '/now', dedupeKey: id,
    ts: new Date(T0 - minutesAgo * 60_000).toISOString(), decision: 'sent', suppressedBy: null, channels: ['webpush', 'feed'], tappedAt: null, ...over,
  });

  it('lists sent notifications newest first and records a tap once', async () => {
    k = kit();
    const cookie = await k.login();
    await k.deps.store.put('notifications', [synthetic('n1', 30), synthetic('n2', 10), synthetic('n3', 20, { decision: 'suppressed', suppressedBy: 'budget' }), synthetic('n4', 60 * 24 * 30)]);
    const list = json<Notification[]>(await k.app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie } }));
    expect(list.map((n) => n.id)).toEqual(['n2', 'n1']);
    expect(json<Notification[]>(await k.app.inject({ method: 'GET', url: '/api/notifications?all=1', headers: { cookie } })).map((n) => n.id)).toEqual(['n2', 'n3', 'n1']);

    expect(json(await k.app.inject({ method: 'POST', url: '/api/notifications/n1/tap', headers: { cookie } }))).toEqual({ ok: true });
    const tapped = (await k.deps.store.get('notifications', 'n1'))!.tappedAt;
    expect(tapped).toBe(new Date(T0).toISOString());
    k.now.t += 5000;
    await k.app.inject({ method: 'POST', url: '/api/notifications/n1/tap', headers: { cookie } });
    expect((await k.deps.store.get('notifications', 'n1'))!.tappedAt).toBe(tapped);
    expect((await k.app.inject({ method: 'POST', url: '/api/notifications/nope/tap', headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('profile', () => {
  it('seeds from profile.yaml once, serves it, validates a PUT, and applies DESK_TZ', async () => {
    k = kit({ DESK_TZ: 'America/Chicago' });
    const cookie = await k.login();
    expect((await k.app.inject({ method: 'GET', url: '/api/profile', headers: { cookie } })).statusCode).toBe(404);
    expect(await seedProfile(k.deps.store)).toBe(true);
    expect(await seedProfile(k.deps.store)).toBe(false);
    const p = json<Profile>(await k.app.inject({ method: 'GET', url: '/api/profile', headers: { cookie } }));
    expect(p.timezone).toBe('America/Chicago');
    expect(p.notifications.quietHours).toEqual({ from: '23:30', to: '06:00' });
    expect(p.failurePatterns).toHaveLength(8);

    const edited = { ...p, timezone: 'America/New_York', notifications: { ...p.notifications, p1PerSession: 6 } };
    const put = await k.app.inject({ method: 'PUT', url: '/api/profile', headers: { cookie }, payload: edited });
    expect(put.statusCode).toBe(200);
    expect((await k.deps.store.kvGet<Profile>(KV.profile))!.notifications.p1PerSession).toBe(6);

    const bad = await k.app.inject({ method: 'PUT', url: '/api/profile', headers: { cookie }, payload: { ...p, weights: 'heavy' } });
    expect(bad.statusCode).toBe(400);
    expect(json<{ issues: Array<{ path: string }> }>(bad).issues[0]!.path).toBe('weights');
    expect((await k.app.inject({ method: 'PUT', url: '/api/profile', headers: { cookie }, payload: { ...p, timezone: 'Mars/Olympus' } })).statusCode).toBe(400);
    expect((await k.deps.store.kvGet<Profile>(KV.profile))!.notifications.p1PerSession).toBe(6);
  });
});

describe('tradingview webhook', () => {
  const SECRET = 'tv-secret-for-tests';
  const hook = (payload: unknown, headers: Record<string, string> = {}) => k.app.inject({ method: 'POST', url: '/api/hooks/tradingview', payload: payload as object, headers });

  it('rejects a bad secret and stores nothing', async () => {
    k = kit({ TV_WEBHOOK_SECRET: SECRET });
    const r = await hook({ secret: 'nope', symbol: 'NQ1!', tf: '1m', time: '2026-11-16T14:31:00Z', o: 1, h: 2, l: 0.5, c: 1.5 });
    expect(r.statusCode).toBe(401);
    expect(await k.deps.store.getCandles('NQ', '1m')).toEqual([]);
    expect(await k.deps.store.latestQuotes()).toEqual({});
    expect((await hook({ symbol: 'NQ' })).statusCode).toBe(401);
  });

  it('stores a candle and a quote on a good secret, with source tradingview:webhook (synthetic bar)', async () => {
    k = kit({ TV_WEBHOOK_SECRET: SECRET });
    k.now.t = Date.parse('2026-11-16T14:32:00.500Z');
    const r = await hook({ secret: SECRET, symbol: 'CME_MINI:NQ1!', tf: '1m', time: '2026-11-16T14:31:00Z', o: 25000, h: 25010.5, l: 24995, c: 25004.25, v: 1234 });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ ok: true });
    expect(await k.deps.store.getCandles('NQ', '1m')).toEqual([
      { symbol: 'NQ', tf: '1m', t: Date.parse('2026-11-16T14:31:00Z'), o: 25000, h: 25010.5, l: 24995, c: 25004.25, v: 1234, source: 'tradingview:webhook' },
    ]);
    expect((await k.deps.store.latestQuotes())['NQ']).toEqual({ symbol: 'NQ', price: 25004.25, prevClose: null, changePct: null, asOf: '2026-11-16T14:32:00.500Z', source: 'tradingview:webhook', cadenceSec: 60 });
  });

  it('stores a quote only when there is no OHLC, keeps the known previous close, and takes text/plain JSON', async () => {
    k = kit({ TV_WEBHOOK_SECRET: SECRET });
    await k.deps.store.putQuotes([{ symbol: 'NVDA', price: 200, prevClose: 200, changePct: 0, asOf: new Date(T0 - 60_000).toISOString(), source: 'synthetic', cadenceSec: 60 }]);
    const r = await k.app.inject({ method: 'POST', url: '/api/hooks/tradingview', headers: { 'content-type': 'text/plain' }, payload: JSON.stringify({ secret: SECRET, symbol: 'NASDAQ:NVDA', price: '202', time: String(T0 / 1000) }) });
    expect(r.statusCode).toBe(200);
    const q = (await k.deps.store.latestQuotes(['NVDA']))['NVDA']!;
    expect(q).toMatchObject({ price: 202, prevClose: 200, source: 'tradingview:webhook', asOf: new Date(T0).toISOString() });
    expect(q.changePct).toBeCloseTo(1, 10);
    expect(await k.deps.store.getCandles('NVDA', '1m')).toEqual([]);
    expect((await hook({ secret: SECRET, symbol: 'NVDA' })).statusCode).toBe(400);
    expect((await hook({ secret: SECRET, symbol: 'NVDA', o: 5, h: 4, l: 3, c: 4.5 })).statusCode).toBe(400);
  });
});

describe('tradingview csv import', () => {
  const post = (cookie: string, payload: object) => k.app.inject({ method: 'POST', url: '/api/import/tradingview-csv', headers: { cookie }, payload });

  it('upserts candles from a chart export with unix-second times and a Volume column (synthetic rows)', async () => {
    k = kit();
    const cookie = await k.login();
    const t = T0 / 1000;
    const csv = `time,open,high,low,close,Volume,Volume MA\r\n${t},100,101,99,100.5,1500,NaN\r\n${t + 60},100.5,102,100,101.75,1800,1650\r\n${t + 120},101.75,102,101,101.25,900,1400\r\n`;
    const r = await post(cookie, { symbol: 'CME_MINI:NQ1!', tf: '1m', csv });
    expect(json(r)).toEqual({ ok: true, bars: 3 });
    const got = await k.deps.store.getCandles('NQ', '1m');
    expect(got.map((c) => c.t)).toEqual([T0, T0 + 60_000, T0 + 120_000]);
    expect(got[1]).toEqual({ symbol: 'NQ', tf: '1m', t: T0 + 60_000, o: 100.5, h: 102, l: 100, c: 101.75, v: 1800, source: 'tradingview:csv' });
    // Importing the same file again changes nothing.
    expect(json(await post(cookie, { symbol: 'NQ', tf: '1m', csv }))).toEqual({ ok: true, bars: 3 });
    expect(await k.deps.store.getCandles('NQ', '1m')).toHaveLength(3);
  });

  it('reads ISO times with an offset and no volume column', async () => {
    k = kit();
    const cookie = await k.login();
    const csv = 'time,open,high,low,close\n2026-11-16T09:30:00-05:00,10,12,9,11\n2026-11-16T09:45:00-05:00,11,13,10,12\n';
    expect(json(await post(cookie, { symbol: 'SYN', tf: '15m', csv }))).toEqual({ ok: true, bars: 2 });
    const got = await k.deps.store.getCandles('SYN', '15m');
    expect(got.map((c) => [new Date(c.t).toISOString(), c.v])).toEqual([['2026-11-16T14:30:00.000Z', 0], ['2026-11-16T14:45:00.000Z', 0]]);
  });

  it('refuses a file with a missing column or an unreadable row, and stores none of it', async () => {
    k = kit();
    const cookie = await k.login();
    const noClose = await post(cookie, { symbol: 'SYN', tf: '1m', csv: 'time,open,high,low\n1,1,1,1\n' });
    expect(noClose.statusCode).toBe(400);
    expect(json<{ error: string }>(noClose).error).toMatch(/Missing column\(s\): close/);
    const badRow = await post(cookie, { symbol: 'SYN', tf: '1m', csv: `time,open,high,low,close\n${T0 / 1000},1,2,0.5,1.5\nyesterday,1,2,0.5,1.5\n` });
    expect(badRow.statusCode).toBe(400);
    expect(json<{ error: string }>(badRow).error).toMatch(/Line 3 is not a bar/);
    expect(await k.deps.store.getCandles('SYN', '1m')).toEqual([]);
    expect((await post(cookie, { symbol: 'SYN', tf: '2h', csv: 'x' })).statusCode).toBe(400);
  });
});

describe('static web export', () => {
  it('serves the export with worker and manifest headers, falls back to index.html, and keeps /api and missing assets as 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'desk-web-'));
    try {
      await mkdir(join(dir, '_next', 'static'), { recursive: true });
      await Promise.all([
        writeFile(join(dir, 'index.html'), '<!doctype html><title>desk index</title>'),
        writeFile(join(dir, 'positions.html'), '<!doctype html><title>desk positions</title>'),
        writeFile(join(dir, 'sw.js'), '/* synthetic worker */'),
        writeFile(join(dir, 'manifest.webmanifest'), '{"name":"Desk"}'),
        writeFile(join(dir, '_next', 'static', 'app.js'), 'export {}'),
      ]);
      k = kit({}, { webDir: dir });
      const get = (url: string) => k.app.inject({ method: 'GET', url });

      const index = await get('/');
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain('desk index');
      expect(index.headers['cache-control']).toBe('no-cache');

      const sw = await get('/sw.js');
      expect(sw.statusCode).toBe(200);
      expect(sw.headers['cache-control']).toBe('no-cache');
      expect(sw.headers['service-worker-allowed']).toBe('/');
      expect(String(sw.headers['content-type'])).toMatch(/javascript/);

      const manifest = await get('/manifest.webmanifest');
      expect(String(manifest.headers['content-type'])).toMatch(/^application\/manifest\+json/);
      expect((await get('/_next/static/app.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');

      expect((await get('/positions')).body).toContain('desk positions');
      const deep = await get('/tickets/abc123?from=push');
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toContain('desk index');

      expect((await get('/missing.js')).statusCode).toBe(404);
      expect((await get('/api/health')).statusCode).toBe(200);
      const unknownApi = await k.app.inject({ method: 'GET', url: '/api/nope', headers: { cookie: await k.login() } });
      expect(unknownApi.statusCode).toBe(404);
      expect(String(unknownApi.headers['content-type'])).toMatch(/json/);
      expect((await get('/..%2f..%2fetc%2fpasswd')).body).not.toContain('root:');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
