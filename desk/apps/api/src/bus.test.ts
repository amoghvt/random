import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Notification } from '@desk/contracts';
import { createBus, MemoryBus, RedisBus, type Bus } from './bus';

const synthetic = (id: string): Notification => ({
  id, class: 'P2', reason: 'synthetic', instrument: null, lines: ['synthetic'], deepLink: '/', dedupeKey: id,
  ts: '2026-11-16T14:30:00.000Z', decision: 'sent', suppressedBy: null, channels: ['feed'], tappedAt: null,
});
const next = <T>(arm: (resolve: (v: T) => void) => void): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no event within 5 s')), 5000);
  arm((v) => { clearTimeout(timer); resolve(v); });
});

function contract(name: string, make: () => Bus[]): void {
  describe(`bus: ${name}`, () => {
    it('delivers a published payload to every subscriber on that channel only, and remembers the last one', async () => {
      const [a, b] = make() as [Bus, Bus];
      try {
        await Promise.all([a.ready(), b.ready()]);
        expect(await b.last('notification')).toBeNull();
        const wrongChannel: unknown[] = [];
        b.subscribe('update', (p) => wrongChannel.push(p));
        const got = next<Notification>((resolve) => b.subscribe('notification', resolve));
        const own = next<Notification>((resolve) => a.subscribe('notification', resolve));
        await a.publish('notification', synthetic('n1'));
        expect(await got).toEqual(synthetic('n1'));
        expect(await own).toEqual(synthetic('n1'));
        expect(wrongChannel).toEqual([]);
        expect(await b.last('notification')).toEqual(synthetic('n1'));
      } finally {
        await Promise.all([...new Set([a, b])].map((x) => x.close()));
      }
    });

    it('stops delivering after unsubscribe', async () => {
      const [a, b] = make() as [Bus, Bus];
      try {
        await Promise.all([a.ready(), b.ready()]);
        const seen: string[] = [];
        const off = b.subscribe('notification', (n) => seen.push(n.id));
        const first = next<Notification>((resolve) => b.subscribe('notification', resolve));
        await a.publish('notification', synthetic('n1'));
        await first;
        off();
        const second = next<Notification>((resolve) => b.subscribe('notification', (n) => { if (n.id === 'n2') resolve(n); }));
        await a.publish('notification', synthetic('n2'));
        await second;
        expect(seen).toEqual(['n1']);
      } finally {
        await Promise.all([...new Set([a, b])].map((x) => x.close()));
      }
    });
  });
}

contract('in-process', () => { const b = new MemoryBus(); return [b, b]; });
it('createBus picks the in-process bus without REDIS_URL', async () => {
  const b = createBus({});
  expect(b).toBeInstanceOf(MemoryBus);
  await b.close();
});

const redisUrl = process.env.REDIS_URL;
describe.skipIf(!redisUrl)('REDIS_URL', () => {
  // Two connections stand in for two processes: what one publishes the other receives.
  contract('redis pub/sub across two clients', () => {
    const prefix = `desk-test-${randomBytes(5).toString('hex')}`;
    return [new RedisBus(redisUrl!, prefix), new RedisBus(redisUrl!, prefix)];
  });
  it('createBus picks Redis when REDIS_URL is set', async () => {
    const b = createBus({ REDIS_URL: redisUrl });
    expect(b).toBeInstanceOf(RedisBus);
    await b.ready();
    await b.close();
  });
});
