import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';
import { AttemptLimiter, authDisabled, safeEqual, setSession } from '../auth';
import { parseWith } from '../http';

const Body = z.object({ token: z.string().min(1).max(512) });

export function register(app: FastifyInstance, deps: AppDeps): void {
  const limiter = new AttemptLimiter(deps.clock);

  app.post('/api/auth/login', async (req, reply): Promise<ApiRoutes['POST /api/auth/login']['res'] | { ok: false; error: string }> => {
    const wait = limiter.blockedFor(req.ip);
    if (wait > 0) {
      void reply.code(429).header('retry-after', String(wait));
      return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` };
    }
    const { token } = parseWith(Body, req.body);
    if (!authDisabled(deps.env) && !safeEqual(token, deps.env.DESK_TOKEN ?? '')) {
      limiter.fail(req.ip);
      void reply.code(401);
      return { ok: false, error: 'Wrong passphrase' };
    }
    limiter.clear(req.ip);
    setSession(req, reply, deps.env, deps.clock());
    return { ok: true };
  });
}
