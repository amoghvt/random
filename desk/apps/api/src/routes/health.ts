import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { KV, type ApiRoutes } from '@desk/contracts';
import type { AppDeps } from '../app';

const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/health', async (): Promise<ApiRoutes['GET /api/health']['res']> => {
    const [lastLoop, kill] = await Promise.all([deps.store.kvGet<unknown>(KV.lastLoop), deps.store.kvGet<boolean>(KV.killSwitch)]);
    const at = typeof lastLoop === 'number' || typeof lastLoop === 'string' ? new Date(lastLoop) : null;
    return { ok: true, version: VERSION, lastLoop: at && Number.isFinite(at.getTime()) ? at.toISOString() : null, killSwitch: kill === true };
  });
}
