/**
 * The one feed interface (spec section 4). Engines never see a provider: they read the store,
 * `ingestOnce` writes it, and a provider is swapped by changing the registry order.
 */
import type { CalendarEvent, Candle, Datum, EarningsInfo, Headline, LaggedFact, PredictionMarket, Quote } from '@desk/contracts';

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What a feed supplies. One slot per kind in the registry; providers inside a slot are interchangeable. */
export type FeedKind =
  | 'quotes' | 'candles' | 'rates' | 'rates_history' | 'fed' | 'vol' | 'calendar' | 'headlines' | 'earnings'
  | 'options' | 'predictions' | 'crypto' | 'positioning' | 'flows' | 'ratings';

interface Payloads {
  candle: Candle; quote: Quote; datum: Datum; headline: Headline; calendar: CalendarEvent;
  prediction: PredictionMarket; earnings: EarningsInfo; lagged: LaggedFact;
}
export type ItemType = keyof Payloads;
/** Every item carries source, timestamp and cadence, whatever the payload. */
export type FeedItem = { [K in ItemType]: {
  type: K; data: Payloads[K]; source: string; asOf: string; cadenceSec: number;
  /** Desk symbol the item is about, when there is one (drives per-symbol fallback). */
  symbol?: string;
  /** e.g. `{ delayed: true, delayMin: 10 }` for Yahoo/TradingView CME data. */
  meta?: Record<string, unknown>;
} }[ItemType];
export type ItemOf<K extends ItemType> = Extract<FeedItem, { type: K }>;

export interface FeedCtx {
  /** Epoch ms. Adapters never call Date.now(). */
  now: number;
  /** Desk symbols wanted this poll; a feed ignores the ones it does not cover. */
  symbols?: string[];
  env: Env;
  /** Injected in tests; defaults to global fetch. */
  fetch?: FetchLike;
  /** Read-only context from the store that some feeds need (FOMC dates, daily candles). */
  calendar?: CalendarEvent[];
  loadCandles?: (symbol: string, tf: Candle['tf']) => Promise<Candle[]>;
}

export type Unsubscribe = () => void;
export interface SubscribeOpts { env: Env; fetch?: FetchLike; intervalMs?: number; onError?: (e: Error) => void; now?: () => number }

export interface Feed<T extends FeedItem = FeedItem> {
  name: string;
  kind: FeedKind;
  /** True when the source updates intraday without a fixed delay for at least part of its coverage. */
  live: boolean;
  /** Env var that must be set, or null for free sources. */
  requiresKey: string | null;
  /** Expected refresh cadence; `ingestOnce` polls a feed when this much time has passed. */
  cadenceSec: number;
  /** False when the adapter was written against docs and never exercised against the real API. */
  verified: boolean;
  enabled(env: Env): boolean;
  poll(ctx: FeedCtx): Promise<T[]>;
  /** `Feed.subscribe(symbol | topic) -> stream`. For polling sources this is a poll loop. */
  subscribe?(topic: string, onData: (items: T[]) => void, opts: SubscribeOpts): Unsubscribe;
}

export const item = <K extends ItemType>(type: K, data: Payloads[K], f: { source: string; asOf: string; cadenceSec: number; symbol?: string; meta?: Record<string, unknown> }): ItemOf<K> =>
  ({ type, data, ...f }) as ItemOf<K>;

/** Poll-loop `subscribe` for request/response sources. `topic` is a desk symbol or '*' for everything. */
export function pollSubscribe<T extends FeedItem>(feed: Pick<Feed<T>, 'poll' | 'cadenceSec'>): NonNullable<Feed<T>['subscribe']> {
  return (topic, onData, opts) => {
    let stopped = false;
    const clock = opts.now ?? Date.now;
    const tick = async (): Promise<void> => {
      try {
        const items = await feed.poll({ now: clock(), symbols: topic === '*' ? undefined : [topic], env: opts.env, fetch: opts.fetch });
        if (!stopped && items.length) onData(items);
      } catch (e) {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), opts.intervalMs ?? feed.cadenceSec * 1000);
    return () => { stopped = true; clearInterval(timer); };
  };
}

export const flagOn = (env: Env, name: string): boolean => ['1', 'true', 'on', 'yes'].includes((env[name] ?? '').toLowerCase());
