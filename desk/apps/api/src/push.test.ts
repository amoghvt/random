import { afterEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { KV, type Notification } from '@desk/contracts';
import { MemoryStore } from '@desk/db';
import { MemoryBus } from './bus';
import { DeskPusher, payloadOf, VAPID_KV, type VapidKeys } from './push';
import { fakeSub, fakeTransport, kit, memoryLog, T0, type Kit } from './testkit';

let k: Kit;
afterEach(async () => { await k?.app.close(); });

const synthetic = (over: Partial<Notification> = {}): Notification => ({
  id: 'n1', class: 'P1', reason: 'synthetic', instrument: 'NQ', lines: ['synthetic fact 27,062', 'synthetic action', 'synthetic flag'], deepLink: '/tickets/t1',
  dedupeKey: 'synthetic:1', ts: new Date(T0).toISOString(), decision: 'sent', suppressedBy: null, channels: ['webpush', 'feed'], tappedAt: null, ...over,
});

describe('pusher', () => {
  it('payload is {title, body, url, tag, class} built from the notification lines', () => {
    expect(payloadOf(synthetic())).toEqual({ title: 'synthetic fact 27,062', body: 'synthetic action\nsynthetic flag', url: '/tickets/t1', tag: 'synthetic:1', class: 'P1' });
  });

  it('deliver: web push to every subscription and always the bus; Telegram only for P0', async () => {
    k = kit({ TELEGRAM_BOT_TOKEN: 'synthetic-token', TELEGRAM_CHAT_ID: '42' });
    const onBus: Notification[] = [];
    k.deps.bus.subscribe('notification', (n) => onBus.push(n));
    await k.deps.push.subscribe(fakeSub(1));
    await k.deps.push.subscribe(fakeSub(2));

    const p1 = await k.deps.push.deliver(synthetic());
    expect(p1).toEqual({ webpush: { sent: 2, pruned: 0, failed: 0 }, telegram: false, channels: ['feed', 'webpush'] });
    expect(k.push.sent).toHaveLength(2);
    expect(k.push.sent[0]!.opts).toMatchObject({ urgency: 'high', ttlSec: 3600 });
    expect(k.push.sent[0]!.opts.topic).toMatch(/^[0-9a-f]{32}$/);
    expect(k.telegram).toEqual([]);

    const p0 = await k.deps.push.deliver(synthetic({ id: 'n2', class: 'P0', dedupeKey: 'synthetic:2' }));
    expect(p0.channels).toEqual(['feed', 'webpush', 'telegram']);
    expect(k.telegram).toHaveLength(1);
    expect(k.telegram[0]).toContain('https://api.telegram.org/botsynthetic-token/sendMessage');
    expect(JSON.parse(k.telegram[0]!.slice(k.telegram[0]!.indexOf('{')))).toEqual({ chat_id: '42', text: 'synthetic fact 27,062\nsynthetic action\nsynthetic flag', disable_web_page_preview: true });
    expect(onBus.map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('deliver: a suppressed notification reaches the bus and nothing else; feed-only skips web push', async () => {
    k = kit({ TELEGRAM_BOT_TOKEN: 'synthetic-token', TELEGRAM_CHAT_ID: '42' });
    const onBus: Notification[] = [];
    k.deps.bus.subscribe('notification', (n) => onBus.push(n));
    await k.deps.push.subscribe(fakeSub(1));
    const suppressed = await k.deps.push.deliver(synthetic({ class: 'P0', decision: 'suppressed', suppressedBy: 'dedupe' }));
    expect(suppressed).toEqual({ webpush: { sent: 0, pruned: 0, failed: 0 }, telegram: false, channels: ['feed'] });
    const feedOnly = await k.deps.push.deliver(synthetic({ id: 'n3', class: 'P3', channels: ['feed'] }));
    expect(feedOnly.channels).toEqual(['feed']);
    expect(k.push.sent).toEqual([]);
    expect(k.telegram).toEqual([]);
    expect(onBus).toHaveLength(2);
  });

  it('deliver never throws: a failing transport is counted and logged, the subscription is kept', async () => {
    const store = new MemoryStore();
    const log = memoryLog();
    const push = new DeskPusher({
      store, bus: new MemoryBus(), env: {}, clock: () => T0, log,
      transport: async (sub) => { if (sub.endpoint.endsWith('/1')) throw new Error('socket hang up'); return { statusCode: 500 }; },
    });
    await push.subscribe(fakeSub(1));
    await push.subscribe(fakeSub(2));
    const r = await push.deliver(synthetic());
    expect(r).toEqual({ webpush: { sent: 0, pruned: 0, failed: 2 }, telegram: false, channels: ['feed'] });
    expect(await store.kvGet(KV.pushSubs)).toHaveLength(2);
    expect(log.lines).toEqual(expect.arrayContaining(['warn push: delivery failed: socket hang up', 'warn push: push service answered 500 for push.invalid']));
  });

  it('VAPID: uses configured keys when present; otherwise generates one pair, persists it and reuses it', async () => {
    const configured = webpush.generateVAPIDKeys();
    const store = new MemoryStore();
    const withEnv = new DeskPusher({ store, bus: new MemoryBus(), env: { VAPID_PUBLIC_KEY: configured.publicKey, VAPID_PRIVATE_KEY: configured.privateKey }, clock: () => T0, transport: fakeTransport().transport });
    expect(await withEnv.publicKey()).toBe(configured.publicKey);
    expect(await store.kvGet(VAPID_KV)).toBeNull();

    const make = () => new DeskPusher({ store, bus: new MemoryBus(), env: {}, clock: () => T0, transport: fakeTransport().transport });
    const first = make();
    const [a, b] = await Promise.all([first.publicKey(), first.publicKey()]);
    expect(a).toBe(b);
    const stored = await store.kvGet<VapidKeys>(VAPID_KV);
    expect(stored!.publicKey).toBe(a);
    // A restart (new pusher, same store) keeps the pair, so installed subscriptions stay valid.
    expect(await make().publicKey()).toBe(a);
    // The generated pair is a real P-256 key the web-push library accepts.
    expect(() => webpush.setVapidDetails('mailto:desk@example.com', stored!.publicKey, stored!.privateKey)).not.toThrow();
  });

  it('unsubscribe removes one endpoint', async () => {
    k = kit();
    await k.deps.push.subscribe(fakeSub(1));
    await k.deps.push.subscribe(fakeSub(2));
    await k.deps.push.unsubscribe(fakeSub(1).endpoint);
    expect((await k.deps.store.kvGet<Array<{ endpoint: string }>>(KV.pushSubs))!.map((s) => s.endpoint)).toEqual([fakeSub(2).endpoint]);
  });
});
