import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hhmm, type ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { parseWith } from '../http';

const Subscribe = z.object({
  endpoint: z.string().url().startsWith('https://').max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
});

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/push/key', async (): Promise<ApiRoutes['GET /api/push/key']['res']> => ({ publicKey: await deps.push.publicKey() }));

  app.post('/api/push/subscribe', async (req): Promise<ApiRoutes['POST /api/push/subscribe']['res']> => {
    await deps.push.subscribe(parseWith(Subscribe, req.body));
    return { ok: true };
  });

  app.post('/api/push/test', async (): Promise<ApiRoutes['POST /api/push/test']['res']> => {
    const now = deps.clock();
    const r = await deps.push.send({ title: 'Desk: test push', body: `Sent ${hhmm(now)} ET. Push works.`, url: '/', tag: `push-test-${now}`, class: 'P2' });
    return { ok: r.sent > 0, sent: r.sent };
  });
}
