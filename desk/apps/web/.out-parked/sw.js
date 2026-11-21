/* Desk service worker. Hand-written; the build script only replaces the BUILD line with the hashed asset list. */
const BUILD = {"version":"d87b19f3e225","assets":["/_next/static/5BHYJSe8cQ8c0Httl45AS/_buildManifest.js","/_next/static/5BHYJSe8cQ8c0Httl45AS/_clientMiddlewareManifest.js","/_next/static/5BHYJSe8cQ8c0Httl45AS/_ssgManifest.js","/_next/static/chunks/0-8fyhfnp8x6m.js","/_next/static/chunks/07cb8raqjig68.js","/_next/static/chunks/07dfegps9fn1k.js","/_next/static/chunks/0cz1d0mv5g_q7.js","/_next/static/chunks/0fiwbi5rcazw8.js","/_next/static/chunks/0jav2ufjmvwi3.js","/_next/static/chunks/0qy7630_p4yok.js","/_next/static/chunks/132js8kbmnibc.js","/_next/static/chunks/1f89q_1t7skol.js","/_next/static/chunks/1fffwgb4xuz94.js","/_next/static/chunks/20vlynlldsvsm.js","/_next/static/chunks/22u7eo1i164vj.js","/_next/static/chunks/24j2io-j289sz.js","/_next/static/chunks/24sf7h301i4b2.js","/_next/static/chunks/2hja62pxqtnlh.js","/_next/static/chunks/2kg148ut5h_8n.js","/_next/static/chunks/2t3h0axbk0w-p.js","/_next/static/chunks/32j_568qor4od.js","/_next/static/chunks/3bgauehav9es4.js","/_next/static/chunks/40gagu5ird97b.js","/_next/static/chunks/42dti23qiporv.css","/_next/static/chunks/turbopack-2u1d16houkiyo.js"]};

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
