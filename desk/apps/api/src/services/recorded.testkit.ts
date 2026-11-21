/**
 * Test-only wiring over data/recorded: a MemoryStore seeded with the real candles and the real US calendar as they
 * stood at a chosen instant (nothing after it), and feeds that release the next closed bars and calendar actuals as
 * the fake clock advances. Nothing here is synthetic market data; account balances a test enters are its own inputs.
 */
import { DATUM_KEYS, DAY, TF_MS, iso, type CalendarEvent, type Candle, type Datum, type Notification, type Store, type Timeframe } from '@desk/contracts';
import { MemoryStore } from '@desk/db';
import { hasRecorded, item, loadRecordedCalendar, loadRecordedCandles, mapTvCalendarRow, type Feed, type FeedItem, type Feeds, type RecordedCalendarRow } from '@desk/feeds';
import { MemoryBus } from '../bus';
import type { DeskDeps } from '../deps';
import { parseEnv } from '../env';
import { DeskPusher, type PushPayload } from '../push';
import { TimerScheduler } from '../scheduler';
import { fakeSub, fakeTransport, memoryLog, type MemoryLog } from '../testkit';

export const RECORDED_SYMBOLS = ['NQ', 'ES', 'SOX', 'VIX', 'US10Y', 'DXY', 'NVDA', 'AMD'];
export const RECORDED_TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];
/** Yield and vol series the live feeds store as data; here they are the recorded 5m closes of the same indices. */
const DATUM_SERIES: Array<{ symbol: string; key: string }> = [
  { symbol: 'US10Y', key: DATUM_KEYS.rate('US10Y') }, { symbol: 'US30Y', key: DATUM_KEYS.rate('US30Y') }, { symbol: 'VIX', key: DATUM_KEYS.vix },
];
const SOURCE = 'yahoo:recorded';

const candleCache = new Map<string, Candle[]>();
export function recorded(symbol: string, tf: Timeframe): Candle[] {
  const k = `${symbol}.${tf}`;
  let cs = candleCache.get(k);
  if (!cs) { cs = hasRecorded(symbol, tf) ? loadRecordedCandles(symbol, tf) : []; candleCache.set(k, cs); }
  return cs;
}
let calendarRows: RecordedCalendarRow[] | null = null;
const calendar = (): RecordedCalendarRow[] => (calendarRows ??= loadRecordedCalendar());

/** A recorded row as the calendar feed would have shown it at `at`: no actual before its release time. */
export function calendarEventAt(r: RecordedCalendarRow, at: number): CalendarEvent {
  const released = Date.parse(r.date) <= at;
  return mapTvCalendarRow({ ...r, actual: released ? r.actual : null }, released ? new Date(r.date).toISOString() : iso(at), 'tradingview:recorded');
}

const closedBetween = (cs: Candle[], tf: Timeframe, after: number, upTo: number): Candle[] => cs.filter((c) => c.t + TF_MS[tf] > after && c.t + TF_MS[tf] <= upTo);
const datumOf = (key: string, c: Candle): Datum => ({ key, value: c.c, source: SOURCE, asOf: iso(c.t + TF_MS['5m']), cadenceSec: 300, meta: { tf: '5m' } });

/** Seeds candles closed by `at`, the yield and VIX data up to `at`, and the calendar as known at `at`. */
export async function seedRecorded(store: Store, at: number, opts: { symbols?: string[]; tfs?: Timeframe[] } = {}): Promise<void> {
  for (const symbol of opts.symbols ?? RECORDED_SYMBOLS) {
    for (const tf of opts.tfs ?? RECORDED_TFS) await store.upsertCandles(closedBetween(recorded(symbol, tf), tf, -Infinity, at));
  }
  for (const s of DATUM_SERIES) await store.putData(closedBetween(recorded(s.symbol, '5m'), '5m', at - 30 * DAY, at).map((c) => datumOf(s.key, c)));
  await store.put('calendar', calendar().map((r) => calendarEventAt(r, at)));
}

/**
 * Feeds over the recording: each poll returns the bars that closed since the previous poll and the calendar window
 * as known at the poll time, so an actual appears on the first poll at or after its release.
 */
export function recordedFeeds(from: number, opts: { symbols?: string[]; tfs?: Timeframe[] } = {}): Feeds {
  const symbols = opts.symbols ?? RECORDED_SYMBOLS, tfs = opts.tfs ?? RECORDED_TFS;
  const base = { live: false, requiresKey: null, cadenceSec: 60, verified: true, enabled: () => true };
  let candleCursor = from, dataCursor = from;
  const candles: Feed = {
    ...base, name: 'recorded.candles', kind: 'candles',
    async poll(ctx): Promise<FeedItem[]> {
      const out: FeedItem[] = [];
      for (const symbol of symbols) for (const tf of tfs) {
        for (const c of closedBetween(recorded(symbol, tf), tf, candleCursor, ctx.now)) out.push(item('candle', c, { source: SOURCE, asOf: iso(c.t + TF_MS[tf]), cadenceSec: TF_MS[tf] / 1000, symbol }));
      }
      candleCursor = ctx.now;
      return out;
    },
  };
  const rates: Feed = {
    ...base, name: 'recorded.rates', kind: 'rates_history',
    async poll(ctx): Promise<FeedItem[]> {
      const out = DATUM_SERIES.flatMap((s) => closedBetween(recorded(s.symbol, '5m'), '5m', dataCursor, ctx.now).map((c) => { const d = datumOf(s.key, c); return item('datum', d, { source: SOURCE, asOf: d.asOf, cadenceSec: 300, symbol: d.key }); }));
      dataCursor = ctx.now;
      return out;
    },
  };
  const cal: Feed = {
    ...base, name: 'recorded.calendar', kind: 'calendar',
    async poll(ctx): Promise<FeedItem[]> {
      return calendar().filter((r) => { const t = Date.parse(r.date); return t >= ctx.now - DAY && t <= ctx.now + 42 * DAY; })
        .map((r) => { const e = calendarEventAt(r, ctx.now); return item('calendar', e, { source: e.source, asOf: e.asOf, cadenceSec: 60 }); });
    },
  };
  const slots: Feeds['slots'] = [
    { kind: 'calendar', mode: 'all', feeds: [cal] }, { kind: 'candles', mode: 'all', feeds: [candles] }, { kind: 'rates_history', mode: 'all', feeds: [rates] },
  ];
  return { slots, all: [cal, candles, rates] };
}

export const NO_FEEDS: Feeds = { slots: [], all: [] };

export interface Desk {
  deps: DeskDeps; store: MemoryStore; log: MemoryLog;
  clock: { t: number };
  /** Web pushes that reached the (fake) push service. */
  pushed: Array<{ endpoint: string; payload: PushPayload }>;
  /** Everything published on the bus `notification` channel, sent or suppressed. */
  feed: Notification[];
}

/** Deps on a MemoryStore with an in-process bus, a recording push transport with one subscription, and no network. */
export async function desk(at: number, feeds: Feeds = NO_FEEDS): Promise<Desk> {
  const env = parseEnv({ NODE_ENV: 'test' });
  const clock = { t: at };
  const store = new MemoryStore();
  const bus = new MemoryBus();
  const log = memoryLog();
  const transport = fakeTransport();
  const now = (): number => clock.t;
  const push = new DeskPusher({ store, bus, env, clock: now, log, transport: transport.transport, fetch: async () => ({ ok: true, status: 200 }) });
  await push.subscribe(fakeSub(1));
  const feed: Notification[] = [];
  bus.subscribe('notification', (n) => feed.push(n));
  const deps: DeskDeps = { env, clock: now, store, bus, push, scheduler: new TimerScheduler({ store, clock: now, log }), feeds, log };
  return { deps, store, log, clock, pushed: transport.sent, feed };
}

/** A desk seeded from the recording at `at`, with recorded feeds that continue from there. */
export async function recordedDesk(at: number, opts: { symbols?: string[]; tfs?: Timeframe[] } = {}): Promise<Desk> {
  const d = await desk(at, recordedFeeds(at, opts));
  await seedRecorded(d.store, at, opts);
  return d;
}
