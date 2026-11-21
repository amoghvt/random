import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KV, type ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { parseWith } from '../http';

const Body = z.object({ on: z.boolean() });
type Res = ApiRoutes['GET /api/admin/kill']['res'];

export function register(app: FastifyInstance, deps: AppDeps): void {
  const read = async (): Promise<Res> => ({ killSwitch: (await deps.store.kvGet<boolean>(KV.killSwitch)) === true });

  app.get('/api/admin/kill', read);

  app.post('/api/admin/kill', async (req): Promise<Res> => {
    const { on } = parseWith(Body, req.body);
    await deps.store.kvSet<boolean>(KV.killSwitch, on);
    req.log.warn(`kill switch ${on ? 'ON: every scheduled job is skipped' : 'off'}`);
    return read();
  });
}
