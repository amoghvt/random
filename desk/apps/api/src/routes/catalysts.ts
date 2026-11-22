import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DAY, iso, type ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { HttpError, parseWith } from '../http';

const Query = z.object({
  /** Days ahead on the timeline, and days back for what already resolved. */
  days: z.coerce.number().int().min(1).max(60).default(7),
  past: z.coerce.number().int().min(0).max(365).default(1),
});

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/catalysts', async (req): Promise<ApiRoutes['GET /api/catalysts']['res']> => {
    const q = parseWith(Query, req.query);
    const now = deps.clock();
    return deps.store.list('catalysts', { since: iso(now - q.past * DAY), until: iso(now + q.days * DAY), order: 'asc' });
  });

  app.get<{ Params: { id: string } }>('/api/catalysts/:id', async (req): Promise<ApiRoutes['GET /api/catalysts/:id']['res']> => {
    const c = await deps.store.get('catalysts', req.params.id);
    if (!c) throw new HttpError(404, 'No such catalyst');
    return c;
  });
}
