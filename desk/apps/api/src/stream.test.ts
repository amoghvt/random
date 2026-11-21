import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Notification, NowView } from '@desk/contracts';
import { kit, T0, type Kit } from './testkit';

let k: Kit;
afterEach(async () => { await k?.app.close(); });

interface SseEvent { event: string; data: unknown }
/** Reads SSE frames off a live HTTP response until `count` named events arrived. */
async function readEvents(res: Response, count: number, skip: string[] = []): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: SseEvent[] = [];
  let buf = '';
  const deadline = setTimeout(() => void reader.cancel(), 5000);
  try {
    while (out.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event && data && !skip.includes(event)) out.push({ event, data: JSON.parse(data) });
      }
    }
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

const synthetic: Notification = {
  id: 'n1', class: 'P1', reason: 'synthetic', instrument: 'NQ', lines: ['synthetic'], deepLink: '/', dedupeKey: 'synthetic',
  ts: new Date(T0).toISOString(), decision: 'sent', suppressedBy: null, channels: ['feed'], tappedAt: null,
};

describe('GET /api/stream', () => {
  it('delivers a bus event to a connected client as a server-sent event', async () => {
    k = kit();
    const cookie = await k.login();
    await k.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(k.app.server.address() as AddressInfo).port}`;

    expect((await fetch(`${base}/api/stream`)).status).toBe(401);

    const res = await fetch(`${base}/api/stream`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    const reading = readEvents(res, 3);
    // The first ping proves the subscription is live before anything is published.
    const first = await readEvents(await fetch(`${base}/api/stream`, { headers: { cookie } }), 1);
    expect(first[0]!.event).toBe('ping');
    await k.deps.bus.publish('notification', synthetic);
    await k.deps.push.deliver({ ...synthetic, id: 'n2' });
    const events = await reading;
    expect(events.map((e) => e.event)).toEqual(['ping', 'notification', 'notification']);
    expect(events[1]!.data).toEqual(synthetic);
    expect((events[2]!.data as Notification).id).toBe('n2');
  });

  it('sends the last known `now` on connect and a heartbeat on the interval', async () => {
    k = kit({}, { heartbeatMs: 40 });
    const cookie = await k.login();
    const now = { asOf: new Date(T0).toISOString(), synthetic: true } as unknown as NowView;
    await k.deps.bus.publish('now', now);
    await k.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(k.app.server.address() as AddressInfo).port}`;
    const events = await readEvents(await fetch(`${base}/api/stream`, { headers: { cookie } }), 4);
    expect(events.map((e) => e.event).sort()).toEqual(['now', 'ping', 'ping', 'ping']);
    expect(events.find((e) => e.event === 'now')!.data).toEqual(now);
  });

  it('releases its bus subscriptions when the client disconnects, and close() does not hang on open streams', async () => {
    k = kit();
    const cookie = await k.login();
    await k.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(k.app.server.address() as AddressInfo).port}`;
    let delivered = 0;
    const realSubscribe = k.deps.bus.subscribe.bind(k.deps.bus);
    let live = 0;
    k.deps.bus.subscribe = ((channel, fn) => {
      live++;
      const off = realSubscribe(channel, (p) => { delivered++; fn(p); });
      return () => { live--; off(); };
    }) as typeof k.deps.bus.subscribe;

    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream`, { headers: { cookie }, signal: ac.signal });
    await readEvents(res, 1);
    ac.abort();
    for (let i = 0; i < 100 && live > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(live).toBe(0);

    const held = await fetch(`${base}/api/stream`, { headers: { cookie } });
    const reader = held.body!.getReader();
    await reader.read();
    expect(live).toBe(4);
    await k.deps.bus.publish('notification', synthetic);
    expect(delivered).toBe(1);
    await k.app.close();
    expect(live).toBe(0);
  });
});
