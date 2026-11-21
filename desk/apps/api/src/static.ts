import { existsSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the Next static export. Unknown non-API GETs fall back to the matching exported page
 * (`/positions` -> `positions.html` or `positions/index.html`) and then to `index.html`.
 */
export function registerWeb(app: FastifyInstance, root: string): void {
  void app.register(fastifyStatic, {
    root,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      const name = basename(filePath);
      if (name === 'sw.js') {
        // The worker must control the whole origin and must never be served stale, or updates and push handlers lag.
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Service-Worker-Allowed', '/');
      } else if (name === 'manifest.webmanifest') {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${sep}_next${sep}static${sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (name.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  });

  app.setNotFoundHandler((req, reply) => {
    const path = (req.url.split('?')[0] ?? '/').replace(/\/+$/, '');
    if (path.startsWith('/api') || (req.method !== 'GET' && req.method !== 'HEAD')) return reply.code(404).send({ error: 'Not found' });
    // A missing asset is a real 404; answering it with HTML would hand the browser a broken script or worker.
    if (/\.[a-z0-9]+$/i.test(path)) return reply.code(404).send({ error: 'Not found' });
    if (/^(\/[\w-]+)+$/.test(path)) {
      for (const candidate of [`${path.slice(1)}.html`, `${path.slice(1)}/index.html`]) {
        if (existsSync(join(root, candidate))) return reply.code(200).sendFile(candidate);
      }
    }
    return reply.code(200).sendFile('index.html');
  });
}
