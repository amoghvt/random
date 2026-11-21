import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { BUS_CHANNELS } from '../bus';

export const HEARTBEAT_MS = 20_000;

/** GET /api/stream: server-sent events `update`, `call`, `notification`, `now`, plus a `ping` heartbeat. */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const open = new Set<ServerResponse>();

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would hold events back past the 2-second feed target.
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    res.write('retry: 3000\n\n');
    send('ping', { t: new Date(deps.clock()).toISOString() });

    const unsubscribe = BUS_CHANNELS.map((c) => deps.bus.subscribe(c, (payload) => send(c, payload)));
    const heartbeat = setInterval(() => send('ping', { t: new Date(deps.clock()).toISOString() }), deps.heartbeatMs ?? HEARTBEAT_MS);
    open.add(res);
    // A client that connects between publishes starts from the current picture instead of waiting for the next loop.
    deps.bus.last('now').then((v) => { if (v && open.has(res)) send('now', v); }).catch(() => undefined);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      for (const u of unsubscribe) u();
      open.delete(res);
    });
  });

  // Open streams would hold the server open on shutdown.
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });
}
