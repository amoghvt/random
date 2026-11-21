import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DAY, type ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { HttpError, parseWith } from '../http';

const Query = z.object({
  /** Suppressed notifications are kept for the journal; the feed shows what was sent unless asked. */
  all: z.enum(['0', '1']).optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/notifications', async (req): Promise<ApiRoutes['GET /api/notifications']['res']> => {
    const q = parseWith(Query, req.query);
    const rows = await deps.store.list('notifications', { since: new Date(deps.clock() - q.days * DAY).toISOString() });
    return (q.all === '1' ? rows : rows.filter((n) => n.decision === 'sent')).slice(0, q.limit);
  });

  app.post<{ Params: { id: string } }>('/api/notifications/:id/tap', async (req): Promise<ApiRoutes['POST /api/notifications/:id/tap']['res']> => {
    const n = await deps.store.get('notifications', req.params.id);
    if (!n) throw new HttpError(404, 'No such notification');
    if (n.tappedAt === null) await deps.store.put('notifications', [{ ...n, tappedAt: new Date(deps.clock()).toISOString() }]);
    return { ok: true };
  });
}
