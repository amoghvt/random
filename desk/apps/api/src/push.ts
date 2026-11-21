import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { KV, type Notification, type NotifyClass, type PushSubscribeBody, type Store } from '@desk/contracts';
import type { Bus } from './bus';
import type { Env } from './env';
import { errText, silentLog, type Log } from './log';

/** What the service worker receives. */
export interface PushPayload { title: string; body: string; url: string; tag: string; class: NotifyClass }
export interface StoredSubscription extends PushSubscribeBody { createdAt: string }
export interface VapidKeys { publicKey: string; privateKey: string }
export interface WebPushOptions { vapid: VapidKeys & { subject: string }; ttlSec: number; urgency: 'high' | 'normal'; topic: string }
/** One push to one subscription. Resolves with the push service's HTTP status; rejects on a network error. */
export type WebPushTransport = (sub: PushSubscribeBody, payload: string, opts: WebPushOptions) => Promise<{ statusCode: number }>;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface WebPushResult { sent: number; pruned: number; failed: number }
export interface DeliveryResult { webpush: WebPushResult; telegram: boolean; channels: Notification['channels'] }

export interface Pusher {
  /** The VAPID public key the browser subscribes with. Generated and persisted on first use when not configured. */
  publicKey(): Promise<string | null>;
  subscribe(sub: PushSubscribeBody): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  /** Web push to every stored subscription. Subscriptions the push service reports gone (404/410) are pruned. */
  send(payload: PushPayload): Promise<WebPushResult>;
  /**
   * A notification-engine decision, delivered: always published to the bus (in-app feed); web push when the
   * decision is `sent` and its channels include `webpush`; Telegram too for a sent P0. Never throws.
   */
  deliver(n: Notification): Promise<DeliveryResult>;
}

export const VAPID_KV = 'push.vapid';
const DEFAULT_SUBJECT = 'mailto:desk@example.com';

export const payloadOf = (n: Notification): PushPayload =>
  ({ title: n.lines[0] ?? '', body: n.lines.slice(1).join('\n'), url: n.deepLink, tag: n.dedupeKey, class: n.class });

export const realWebPush: WebPushTransport = async (sub, payload, opts) => {
  try {
    const r = await webpush.sendNotification(sub, payload, { vapidDetails: opts.vapid, TTL: opts.ttlSec, urgency: opts.urgency, topic: opts.topic });
    return { statusCode: r.statusCode };
  } catch (e) {
    if (e instanceof webpush.WebPushError) return { statusCode: e.statusCode };
    throw e;
  }
};

export interface PusherDeps {
  store: Store; bus: Bus; env: Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT' | 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>;
  clock: () => number; log?: Log; transport?: WebPushTransport; fetch?: FetchLike;
}

export class DeskPusher implements Pusher {
  private readonly log: Log;
  private readonly transport: WebPushTransport;
  private readonly fetch: FetchLike;
  private vapid: Promise<VapidKeys> | null = null;
  /** Serializes read-modify-write of the subscription list. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PusherDeps) {
    this.log = deps.log ?? silentLog;
    this.transport = deps.transport ?? realWebPush;
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  }

  private keys(): Promise<VapidKeys> {
    this.vapid ??= (async () => {
      const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = this.deps.env;
      if (publicKey && privateKey) return { publicKey, privateKey };
      const stored = await this.deps.store.kvGet<VapidKeys>(VAPID_KV);
      if (stored?.publicKey && stored.privateKey) return stored;
      const generated = webpush.generateVAPIDKeys();
      await this.deps.store.kvSet<VapidKeys>(VAPID_KV, generated);
      this.log.info('push: generated a VAPID key pair and stored it in kv push.vapid');
      return generated;
    })();
    this.vapid.catch(() => { this.vapid = null; });
    return this.vapid;
  }

  async publicKey(): Promise<string | null> {
    return (await this.keys()).publicKey;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async subs(): Promise<StoredSubscription[]> {
    return (await this.deps.store.kvGet<StoredSubscription[]>(KV.pushSubs)) ?? [];
  }

  subscribe(sub: PushSubscribeBody): Promise<void> {
    return this.locked(async () => {
      const rest = (await this.subs()).filter((s) => s.endpoint !== sub.endpoint);
      await this.deps.store.kvSet<StoredSubscription[]>(KV.pushSubs, [...rest, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: new Date(this.deps.clock()).toISOString() }]);
    });
  }

  unsubscribe(endpoint: string): Promise<void> {
    return this.locked(async () => {
      await this.deps.store.kvSet<StoredSubscription[]>(KV.pushSubs, (await this.subs()).filter((s) => s.endpoint !== endpoint));
    });
  }

  async send(payload: PushPayload): Promise<WebPushResult> {
    const subs = await this.subs();
    if (subs.length === 0) return { sent: 0, pruned: 0, failed: 0 };
    const keys = await this.keys();
    const urgent = payload.class === 'P0' || payload.class === 'P1';
    const opts: WebPushOptions = {
      vapid: { ...keys, subject: this.deps.env.VAPID_SUBJECT ?? DEFAULT_SUBJECT },
      ttlSec: urgent ? 3600 : 6 * 3600,
      urgency: urgent ? 'high' : 'normal',
      // Same tag replaces an undelivered push at the push service (a worsening supersedes the earlier one).
      topic: createHash('sha1').update(payload.tag).digest('hex').slice(0, 32),
    };
    const body = JSON.stringify(payload);
    const gone: string[] = [];
    const result: WebPushResult = { sent: 0, pruned: 0, failed: 0 };
    await Promise.all(subs.map(async (s) => {
      try {
        const { statusCode } = await this.transport({ endpoint: s.endpoint, keys: s.keys }, body, opts);
        if (statusCode >= 200 && statusCode < 300) result.sent++;
        else if (statusCode === 404 || statusCode === 410) gone.push(s.endpoint);
        else { result.failed++; this.log.warn(`push: push service answered ${statusCode} for ${new URL(s.endpoint).host}`); }
      } catch (e) {
        result.failed++;
        this.log.warn(`push: delivery failed: ${errText(e)}`);
      }
    }));
    if (gone.length > 0) {
      await this.locked(async () => {
        await this.deps.store.kvSet<StoredSubscription[]>(KV.pushSubs, (await this.subs()).filter((s) => !gone.includes(s.endpoint)));
      });
      result.pruned = gone.length;
      this.log.info(`push: pruned ${gone.length} expired subscription(s)`);
    }
    return result;
  }

  private async telegram(n: Notification): Promise<boolean> {
    const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = this.deps.env;
    if (!token || !chat) return false;
    const r = await this.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: n.lines.join('\n'), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) this.log.warn(`push: telegram answered ${r.status}`);
    return r.ok;
  }

  async deliver(n: Notification): Promise<DeliveryResult> {
    const out: DeliveryResult = { webpush: { sent: 0, pruned: 0, failed: 0 }, telegram: false, channels: [] };
    try {
      await this.deps.bus.publish('notification', n);
      out.channels.push('feed');
    } catch (e) { this.log.error(`push: bus publish failed: ${errText(e)}`); }
    if (n.decision !== 'sent') return out;
    if (n.channels.includes('webpush')) {
      try {
        out.webpush = await this.send(payloadOf(n));
        if (out.webpush.sent > 0) out.channels.push('webpush');
      } catch (e) { this.log.error(`push: web push failed: ${errText(e)}`); }
    }
    if (n.class === 'P0') {
      try {
        out.telegram = await this.telegram(n);
        if (out.telegram) out.channels.push('telegram');
      } catch (e) { this.log.error(`push: telegram failed: ${errText(e)}`); }
    }
    return out;
  }
}
