/* Desk service worker. Hand-written; the build script only replaces the BUILD line with the hashed asset list. */
const BUILD = { version: 'dev', assets: [] }; // @build-inject

const SHELL_CACHE = `desk-shell-${BUILD.version}`;
const API_CACHE = 'desk-api-v1';
const SHELL = ['/', '/catalysts/', '/positions/', '/ticket/', '/journal/', '/ask/', '/chart/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One missing file must not abort the install, so each entry is cached on its own.
    await Promise.allSettled([...SHELL, ...BUILD.assets].map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('desk-shell-') && n !== SHELL_CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function networkFirstApi(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await cache.match(request);
    return hit ?? new Response(JSON.stringify({ error: 'Offline' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
}

async function navigate(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    return await fetch(request);
  } catch {
    const path = new URL(request.url).pathname;
    const page = path.endsWith('/') ? path : `${path}/`;
    return (await cache.match(page)) ?? (await cache.match('/')) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api/stream' || url.pathname === '/sw.js') return;
  if (url.pathname.startsWith('/api/')) event.respondWith(networkFirstApi(request));
  else if (request.mode === 'navigate') event.respondWith(navigate(request));
  else event.respondWith(cacheFirst(request));
});

/** Payload from the API: { title, body, url, tag, class, id? }. `data: { url, id }` is accepted too. */
function readPush(event) {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch { p = { title: 'Desk', body: event.data ? event.data.text() : '' }; }
  const data = p.data ?? {};
  const url = p.url ?? data.url ?? '/';
  let id = p.id ?? data.id ?? null;
  if (!id) {
    try { id = new URL(url, self.location.origin).searchParams.get('prefill'); } catch { id = null; }
  }
  return { title: p.title || 'Desk', body: p.body ?? '', tag: p.tag ?? undefined, cls: p.class ?? data.class ?? null, url, id };
}

self.addEventListener('push', (event) => {
  const n = readPush(event);
  event.waitUntil(self.registration.showNotification(n.title, {
    body: n.body,
    tag: n.tag,
    renotify: Boolean(n.tag),
    requireInteraction: n.cls === 'P0',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: n.url, id: n.id },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/', id = null } = event.notification.data ?? {};
  const target = new URL(url, self.location.origin).href;
  event.waitUntil((async () => {
    if (id) {
      await fetch(`/api/notifications/${encodeURIComponent(id)}/tap`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) {
      await open.focus().catch(() => undefined);
      const moved = await open.navigate(target).catch(() => null);
      if (moved) return;
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    let key = event.oldSubscription?.options?.applicationServerKey ?? null;
    if (!key) {
      const r = await fetch('/api/push/key', { credentials: 'include' });
      key = (await r.json()).publicKey;
    }
    if (!key) return;
    const sub = event.newSubscription ?? (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    const json = sub.toJSON();
    await fetch('/api/push/subscribe', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
  })());
});
