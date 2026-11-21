import type { FastifyInstance } from 'fastify';
import { KV, Profile, type ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { HttpError, parseWith } from '../http';
import { getProfile } from '../profile';

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/profile', async (): Promise<ApiRoutes['GET /api/profile']['res']> => {
    const p = await getProfile(deps.store, deps.env);
    if (!p) throw new HttpError(404, 'No profile stored yet');
    return p;
  });

  app.put('/api/profile', async (req): Promise<ApiRoutes['PUT /api/profile']['res']> => {
    const p = parseWith(Profile, req.body);
    try { new Intl.DateTimeFormat('en-US', { timeZone: p.timezone }); } catch { throw new HttpError(400, `Unknown timezone ${p.timezone}`); }
    await deps.store.kvSet<Profile>(KV.profile, p);
    return p;
  });
}
