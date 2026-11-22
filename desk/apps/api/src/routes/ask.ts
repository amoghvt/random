import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { parseWith } from '../http';
import { ask, askHistory } from '../services/ask';

const Body = z.object({ text: z.string().trim().min(1).max(2000), checkLive: z.boolean().optional() });

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/ask/history', async (): Promise<ApiRoutes['GET /api/ask/history']['res']> => askHistory(deps, deps.clock()));

  app.post('/api/ask', async (req): Promise<ApiRoutes['POST /api/ask']['res']> => {
    const b = parseWith(Body, req.body);
    return ask(deps, { text: b.text, ...(b.checkLive !== undefined ? { checkLive: b.checkLive } : {}) }, deps.clock());
  });
}
