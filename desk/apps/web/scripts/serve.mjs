/* global console, process */
/** Tiny static server for an exported directory: `node scripts/serve.mjs [dir] [port]`. */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const isFile = (p) => existsSync(p) && statSync(p).isFile();

export function serve(dir, port = 0) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    if (path.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"No API behind this static server"}');
      return;
    }
    const base = join(root, path);
    const file = [base, join(base, 'index.html'), `${base.replace(/[/\\]$/, '')}.html`].find(isFile) ?? (extname(path) ? null : join(root, 'index.html'));
    if (!file || !file.startsWith(root)) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const { url } = await serve(process.argv[2] ?? join(here, '..', 'out'), Number(process.argv[3] ?? 4173));
  console.log(`serving ${url}`);
}
