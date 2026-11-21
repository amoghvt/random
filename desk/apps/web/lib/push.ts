'use client';
/** Web push enrolment. `enablePush` must run inside a tap handler: iOS only grants permission on a user gesture. */
import { api } from './api';

export interface PushSupport { supported: boolean; ios: boolean; standalone: boolean; permission: NotificationPermission | 'unsupported' }

export function pushSupport(): PushSupport {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return { supported, ios, standalone, permission: 'Notification' in window ? Notification.permission : 'unsupported' };
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Returns a one-line result for the settings sheet. */
export async function enablePush(): Promise<{ ok: boolean; text: string }> {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return { ok: false, text: 'This browser has no web push.' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, text: permission === 'denied' ? 'Notifications are blocked for this site in system settings.' : 'Permission not granted.' };
  const { publicKey } = await api('GET /api/push/key');
  if (!publicKey) return { ok: false, text: 'The server has no VAPID key configured.' };
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return { ok: false, text: 'The browser returned an incomplete subscription.' };
  await api('POST /api/push/subscribe', { body: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } } });
  return { ok: true, text: 'Notifications on for this device.' };
}
