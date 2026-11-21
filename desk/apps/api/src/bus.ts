import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import type { BiasCall, Notification, NowView, WatcherUpdate } from '@desk/contracts';
import { errText, silentLog, type Log } from './log';

/** Channel name = SSE event name. */
export interface BusEvents { update: WatcherUpdate; call: BiasCall; notification: Notification; now: NowView }
export type BusChannel = keyof BusEvents;
export const BUS_CHANNELS: BusChannel[] = ['update', 'call', 'notification', 'now'];

export interface Bus {
  /** Resolves once subscriptions are live (immediately for the in-process bus). */
  ready(): Promise<void>;
  publish<C extends BusChannel>(channel: C, payload: BusEvents[C]): Promise<void>;
  /** Returns the unsubscribe function. */
  subscribe<C extends BusChannel>(channel: C, fn: (payload: BusEvents[C]) => void): () => void;
  /** Live state: the most recent payload published on a channel, so a new client starts from the current picture. */
  last<C extends BusChannel>(channel: C): Promise<BusEvents[C] | null>;
  close(): Promise<void>;
}

abstract class LocalFanout {
  protected readonly emitter = new EventEmitter().setMaxListeners(0);
  subscribe<C extends BusChannel>(channel: C, fn: (payload: BusEvents[C]) => void): () => void {
    this.emitter.on(channel, fn);
    return () => { this.emitter.off(channel, fn); };
  }
}

export class MemoryBus extends LocalFanout implements Bus {
  private readonly latest = new Map<BusChannel, string>();
  async ready(): Promise<void> { /* nothing to connect */ }
  async publish<C extends BusChannel>(channel: C, payload: BusEvents[C]): Promise<void> {
    const json = JSON.stringify(payload);
    this.latest.set(channel, json);
    this.emitter.emit(channel, JSON.parse(json));
  }
  async last<C extends BusChannel>(channel: C): Promise<BusEvents[C] | null> {
    const json = this.latest.get(channel);
    return json === undefined ? null : (JSON.parse(json) as BusEvents[C]);
  }
  async close(): Promise<void> { this.emitter.removeAllListeners(); }
}

/** Redis pub/sub: every process subscribed to the same prefix sees every event, including its own. */
export class RedisBus extends LocalFanout implements Bus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly subscribed: Promise<void>;

  constructor(url: string, private readonly prefix = 'desk', log: Log = silentLog) {
    super();
    this.pub = new Redis(url);
    this.sub = new Redis(url);
    for (const c of [this.pub, this.sub]) c.on('error', (e: Error) => log.error(`bus: redis ${errText(e)}`));
    this.sub.on('message', (topic: string, message: string) => {
      const channel = topic.slice(this.topic('').length);
      try { this.emitter.emit(channel, JSON.parse(message)); } catch (e) { log.error(`bus: bad message on ${topic}: ${errText(e)}`); }
    });
    this.subscribed = this.sub.subscribe(...BUS_CHANNELS.map((c) => this.topic(c))).then(() => undefined);
  }
  private topic(channel: string): string { return `${this.prefix}:bus:${channel}`; }
  ready(): Promise<void> { return this.subscribed; }
  async publish<C extends BusChannel>(channel: C, payload: BusEvents[C]): Promise<void> {
    const json = JSON.stringify(payload);
    await this.pub.multi().set(`${this.prefix}:last:${channel}`, json).publish(this.topic(channel), json).exec();
  }
  async last<C extends BusChannel>(channel: C): Promise<BusEvents[C] | null> {
    const json = await this.pub.get(`${this.prefix}:last:${channel}`);
    return json === null ? null : (JSON.parse(json) as BusEvents[C]);
  }
  async close(): Promise<void> {
    this.emitter.removeAllListeners();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

export function createBus(env: { REDIS_URL?: string | undefined }, log: Log = silentLog): Bus {
  return env.REDIS_URL ? new RedisBus(env.REDIS_URL, 'desk', log) : new MemoryBus();
}
