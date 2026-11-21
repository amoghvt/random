/* global console, process */
/**
 * Static export. `node scripts/build.mjs` writes ./out (production; refuses the mock flag and fails if
 * mock fixtures are found in the bundle). `--mock` writes ./out-mock with NEXT_PUBLIC_MOCK=1 for UI verification.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'DESK_MOCK_FIXTURES';
const mock = process.argv.includes('--mock');
const fail = (msg) => { console.error(`build: ${msg}`); process.exit(1); };

if (!mock && process.env.NEXT_PUBLIC_MOCK) fail('NEXT_PUBLIC_MOCK is set. Mock data never ships: unset it, or run `pnpm build:mock` for the verification build.');

const env = { ...process.env, NODE_ENV: 'production' };
if (mock) env.NEXT_PUBLIC_MOCK = '1';
else delete env.NEXT_PUBLIC_MOCK;

const out = join(ROOT, 'out');
const target = join(ROOT, mock ? 'out-mock' : 'out');
const parked = join(ROOT, '.out-parked');
// A mock build must not clobber an existing production export.
if (mock && existsSync(out)) renameSync(out, parked);
const built = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], { cwd: ROOT, env, stdio: 'inherit' });
if (mock) {
  if (built.status === 0) {
    rmSync(target, { recursive: true, force: true });
    renameSync(out, target);
  }
  if (existsSync(parked)) renameSync(parked, out);
}
if (built.status !== 0) fail('next build failed');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(target);
const rel = (p) => `/${relative(target, p).split('\\').join('/')}`;

for (const need of ['index.html', 'manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png']) {
  if (!existsSync(join(target, need))) fail(`missing ${need} in ${relative(ROOT, target)}/ (run \`pnpm icons\` if the icons are missing)`);
}

const leaked = files.filter((p) => /\.(js|html|txt|json)$/.test(p) && readFileSync(p, 'utf8').includes(MARKER)).map(rel);
if (!mock && leaked.length > 0) fail(`mock fixtures found in the production bundle: ${leaked.join(', ')}`);
if (mock && leaked.length === 0) fail('mock build contains no fixtures; the mock flag did not take effect');

// Precache list for the service worker: every hashed static asset.
const assets = files.map(rel).filter((p) => p.startsWith('/_next/static/')).sort();
const version = createHash('sha1').update(assets.join('|')).update(readFileSync(join(target, 'index.html'))).digest('hex').slice(0, 12);
const swPath = join(target, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const line = /^const BUILD = .*@build-inject$/m;
if (!line.test(sw)) fail('sw.js has no @build-inject line');
writeFileSync(swPath, sw.replace(line, `const BUILD = ${JSON.stringify({ version, assets })};`));

console.log(`build: ${relative(ROOT, target)}/ ready, ${files.length} files, sw cache desk-shell-${version}, ${assets.length} precached assets${mock ? ' [MOCK]' : ', no mock fixtures'}`);
