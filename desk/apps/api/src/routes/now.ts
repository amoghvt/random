import type { FastifyInstance } from 'fastify';
import type { ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { nowView } from '../services/now';
import { refreshNow } from '../services/refresh';
import { sessionView } from '../services/session';

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/now', async (): Promise<ApiRoutes['GET /api/now']['res']> => nowView(deps, deps.clock()));

  /** Today's session direction call and its replayed record. */
  app.get('/api/session-call', async () => sessionView(deps, deps.clock()));

  /** Pull to refresh: the feeds are re-polled and the engines re-run before the view is read. */
  app.post('/api/refresh', async (): Promise<ApiRoutes['POST /api/refresh']['res']> => refreshNow(deps, deps.clock()));
}
