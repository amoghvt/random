import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Store } from '@desk/contracts';
import { authDisabled, hasSession, isPublicPath, sessionSecret } from './auth';
import type { Bus } from './bus';
import type { Env } from './env';
import { HttpError } from './http';
import type { Pusher } from './push';
import { routes } from './routes/index';
import type { Scheduler } from './scheduler';
import { registerWeb } from './static';

export interface AppDeps {
  store: Store;
  env: Env;
  bus: Bus;
  push: Pusher;
  scheduler: Scheduler;
  /** Epoch ms. Injected so tests and the replay control time. */
  clock: () => number;
  /** Directory of the static web export (apps/web/out). Served with an index.html fallback when it exists. */
  webDir?: string;
  /** SSE heartbeat interval; 20 s when omitted. */
  heartbeatMs?: number;
}
/** Every file in src/routes exports `register` with this shape and is listed in src/routes/index.ts. */
export type RouteModule = (app: FastifyInstance, deps: AppDeps) => void;

export function buildApp(deps: AppDeps): FastifyInstance {
  const { env } = deps;
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });
  void app.register(cookie, { secret: sessionSecret(env) });

  // TradingView posts alert JSON as text/plain when the message is not strictly JSON; accept both.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, JSON.parse(String(body))); } catch { done(new HttpError(400, 'Body is not JSON')); }
  });

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (isPublicPath(path) || authDisabled(env) || hasSession(req, deps.clock())) return;
    return reply.code(401).send({ error: 'Not signed in' });
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const status = typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'Server error' : message });
  });

  for (const register of routes) register(app, deps);

  const webDir = deps.webDir && existsSync(deps.webDir) ? deps.webDir : null;
  if (webDir) registerWeb(app, webDir);
  else app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));
  return app;
}
