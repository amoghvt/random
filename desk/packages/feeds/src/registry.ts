/**
 * Feed registry and the ingest step of the 60-second loop.
 * `buildFeeds(env)` orders the enabled providers of each data type best-first; `ingestOnce` polls what is
 * due, validates against the contract schemas, writes the store and records per-feed health in kv
 * `feeds.health`. A failing feed is recorded and skipped: nothing thrown by a provider leaves `ingestOnce`.
 */
import {
  CalendarEvent, Candle, Datum, EarningsInfo, Headline, INSTRUMENTS, KV, LaggedFact, PredictionMarket, Quote, DAY, HOUR, iso,
  type Store, type Timeframe,
} from '@desk/contracts';
import type { z } from 'zod';
import { earningsFeed } from './adapters/earnings';
import { fedWatchFeed } from './adapters/fed';
import { cftc, coinbase, financialJuice, forexFactory } from './adapters/free';
import {
  alpacaQuotes, benzingaNews, benzingaRatings, binance, cboeOptions, databentoCandleFeed, etfFlows, fredRates, polygonCandleFeed, polygonQuotes,
  tradierQuotes, tradingEconomics,
} from './adapters/paid';
import { kalshi, polymarket } from './adapters/predictions';
import { tradingViewCalendar, tradingViewQuotes, tradingViewRates, tradingViewVol } from './adapters/tradingview';
import { BACKFILL_RANGE, yahooCandleFeed, yahooCandles, yahooCoverage, yahooOptions, yahooQuotes, yahooRates, yahooRatesHistory, yahooVol } from './adapters/yahoo';
import { dedupeHeadlines } from './headlines';
import { mapLimit } from './http';
import type { FeedHealthRow } from './rules';
import type { Env, Feed, FeedCtx, FeedItem, FeedKind, FetchLike, ItemType, Payloads } from './types';

export interface FeedSlot {
  kind: FeedKind;
  /** 'first': walk the priority list until the wanted coverage is met. 'all': every provider contributes. */
  mode: 'first' | 'all';
  /** Enabled providers, best first. */
  feeds: Feed[];
  /** Item keys a 'first' slot must cover (desk symbols or datum keys); a fallback only fills what is still missing. */
  want?: (symbols: string[]) => string[];
}
export interface Feeds { slots: FeedSlot[]; all: Feed[] }

const priceSymbols = (symbols: string[]): string[] => [...new Set(symbols.map((s) => INSTRUMENTS[s]?.priceSymbol ?? s))];

/** Priority lists. Paid providers lead when their key is present; the free source that works today follows. */
export function buildFeeds(env: Env): Feeds {
  const f = (x: Feed<never> | Feed): Feed => x as Feed;
  const table: FeedSlot[] = [
    // Calendar first: the Fed slot needs the FOMC date from it.
    { kind: 'calendar', mode: 'first', feeds: [f(tradingEconomics), f(tradingViewCalendar), f(forexFactory)] },
    { kind: 'quotes', mode: 'first', feeds: [f(polygonQuotes), f(tradierQuotes), f(alpacaQuotes), f(tradingViewQuotes), f(yahooQuotes)], want: priceSymbols },
    { kind: 'candles', mode: 'all', feeds: [f(databentoCandleFeed), f(polygonCandleFeed), ...(['1m', '5m', '15m', '1h', '1d'] as Timeframe[]).map((tf) => f(yahooCandleFeed(tf)))] },
    { kind: 'rates', mode: 'first', feeds: [f(tradingViewRates), f(yahooRates), f(fredRates)], want: () => ['rate.US2Y', 'rate.US10Y', 'rate.US30Y'] },
    { kind: 'rates_history', mode: 'all', feeds: [f(yahooRatesHistory)] },
    { kind: 'vol', mode: 'first', feeds: [f(tradingViewVol), f(yahooVol)], want: () => ['vol.VIX', 'vol.VIX3M'] },
    { kind: 'fed', mode: 'first', feeds: [f(fedWatchFeed)] },
    { kind: 'headlines', mode: 'all', feeds: [f(financialJuice), f(benzingaNews)] },
    { kind: 'ratings', mode: 'all', feeds: [f(benzingaRatings)] },
    { kind: 'predictions', mode: 'all', feeds: [f(kalshi), f(polymarket)] },
    { kind: 'crypto', mode: 'first', feeds: [f(coinbase), f(binance)] },
    { kind: 'options', mode: 'first', feeds: [f(yahooOptions), f(cboeOptions)] },
    { kind: 'earnings', mode: 'first', feeds: [f(earningsFeed)] },
    { kind: 'positioning', mode: 'first', feeds: [f(cftc)] },
    { kind: 'flows', mode: 'first', feeds: [f(etfFlows)] },
  ];
  const slots = table.map((s) => ({ ...s, feeds: s.feeds.filter((x) => x.enabled(env)) })).filter((s) => s.feeds.length > 0);
  return { slots, all: slots.flatMap((s) => s.feeds) };
}

const SCHEMAS: { [K in ItemType]: z.ZodType } = { candle: Candle, quote: Quote, datum: Datum, headline: Headline, calendar: CalendarEvent, prediction: PredictionMarket, earnings: EarningsInfo, lagged: LaggedFact };

export interface IngestOpts {
  env?: Env; fetch?: FetchLike;
  /** Desk symbols to cover; default is every instrument. */
  symbols?: string[];
  /** Poll everything regardless of cadence (first run, smoke test). */
  force?: boolean;
  /** Restrict to these kinds. */
  kinds?: FeedKind[];
}
export interface IngestReport {
  asOf: string;
  polled: Array<{ feed: string; kind: FeedKind; ok: boolean; items: number; invalid: number; error: string | null; ms: number }>;
  written: Record<ItemType, number>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 240);

async function write(store: Store, items: FeedItem[], now: number, written: Record<ItemType, number>): Promise<void> {
  const of = <K extends ItemType>(k: K): Array<Payloads[K]> => items.flatMap((i) => (i.type === k ? [i.data as Payloads[K]] : []));
  const candles = of('candle'), quotes = of('quote'), data = of('datum'), calendar = of('calendar'), predictions = of('prediction'), earnings = of('earnings'), lagged = of('lagged');
  let headlines = of('headline');
  if (headlines.length) {
    // Collapse repeats of what earlier polls (or another wire) already stored.
    const recent = await store.list('headlines', { since: iso(now - 6 * HOUR), limit: 500 });
    const ids = new Set(recent.map((h) => h.id));
    headlines = dedupeHeadlines(headlines.filter((h) => !ids.has(h.id)), recent);
  }
  if (candles.length) await store.upsertCandles(candles);
  if (quotes.length) await store.putQuotes(quotes);
  if (data.length) await store.putData(data);
  if (headlines.length) await store.put('headlines', headlines);
  if (calendar.length) await store.put('calendar', calendar);
  if (predictions.length) await store.put('predictions', predictions);
  if (earnings.length) await store.put('earnings', earnings);
  if (lagged.length) await store.put('lagged_facts', lagged);
  written.candle += candles.length; written.quote += quotes.length; written.datum += data.length; written.headline += headlines.length;
  written.calendar += calendar.length; written.prediction += predictions.length; written.earnings += earnings.length; written.lagged += lagged.length;
}

/** One ingest pass. Never throws for a feed failure; the failure lands in the report and in kv `feeds.health`. */
export async function ingestOnce(store: Store, feeds: Feeds, now: number, opts: IngestOpts = {}): Promise<IngestReport> {
  const env = opts.env ?? {};
  const symbols = opts.symbols ?? Object.keys(INSTRUMENTS);
  const health = new Map<string, FeedHealthRow>(((await store.kvGet<FeedHealthRow[]>(KV.feedHealth)) ?? []).map((r) => [r.feed, r]));
  const report: IngestReport = { asOf: iso(now), polled: [], written: { candle: 0, quote: 0, datum: 0, headline: 0, calendar: 0, prediction: 0, earnings: 0, lagged: 0 } };
  const due = (f: Feed): boolean => {
    const last = health.get(f.name)?.lastPoll;
    return opts.force === true || !last || now - Date.parse(last) >= f.cadenceSec * 1000 - 5000;
  };

  const run = async (feed: Feed, slot: FeedSlot, ctxSymbols: string[], keep: ((key: string) => boolean) | null): Promise<FeedItem[]> => {
    const t0 = Date.now();
    const prev = health.get(feed.name);
    let valid: FeedItem[] = [], invalid = 0, error: string | null = null, ok = true;
    try {
      const ctx: FeedCtx = { now, symbols: ctxSymbols, env, fetch: opts.fetch, loadCandles: (s, tf) => store.getCandles(s, tf) };
      if (slot.kind === 'fed') ctx.calendar = await store.list('calendar', { status: 'FOMC', since: iso(now - 120 * DAY), order: 'asc', limit: 200 });
      for (const it of await feed.poll(ctx)) {
        if (!SCHEMAS[it.type].safeParse(it.data).success) { invalid++; continue; }
        if (keep && it.symbol !== undefined && !keep(it.symbol)) continue;
        valid.push(it);
      }
      await write(store, valid, now, report.written);
      if (invalid) error = `${invalid} invalid item${invalid === 1 ? '' : 's'} dropped`;
    } catch (e) {
      ok = false; error = errText(e); valid = [];
    }
    const at = iso(now);
    health.set(feed.name, { feed: feed.name, ok, lastOk: ok ? at : prev?.lastOk ?? null, error, live: feed.live, lastPoll: at });
    report.polled.push({ feed: feed.name, kind: slot.kind, ok, items: valid.length, invalid, error, ms: Date.now() - t0 });
    return valid;
  };

  for (const slot of feeds.slots) {
    if (opts.kinds && !opts.kinds.includes(slot.kind)) continue;
    try {
      if (slot.mode === 'all') {
        for (const feed of slot.feeds) if (due(feed)) await run(feed, slot, symbols, null);
        continue;
      }
      if (!slot.feeds[0] || !due(slot.feeds[0])) continue;
      const want = slot.want?.(symbols);
      const missing = new Set(want ?? []);
      for (const feed of slot.feeds) {
        // A fallback is asked only for what is still missing, and may only write that: it never overwrites the better source.
        const items = await run(feed, slot, slot.kind === 'quotes' && want ? [...missing] : symbols, want ? (k) => missing.has(k) : null);
        for (const it of items) if (it.symbol !== undefined) missing.delete(it.symbol);
        if (want ? missing.size === 0 : items.length > 0) break;
      }
    } catch (e) {
      report.polled.push({ feed: `slot:${slot.kind}`, kind: slot.kind, ok: false, items: 0, invalid: 0, error: errText(e), ms: 0 });
    }
  }
  try {
    // Rows written by the rule scraper (`rules:<host>`) are kept as they are.
    const stored = (await store.kvGet<FeedHealthRow[]>(KV.feedHealth)) ?? [];
    await store.kvSet(KV.feedHealth, [...stored.filter((r) => !health.has(r.feed)), ...health.values()]);
  } catch (e) {
    report.polled.push({ feed: 'kv:feeds.health', kind: 'quotes', ok: false, items: 0, invalid: 0, error: errText(e), ms: 0 });
  }
  return report;
}

export interface BackfillReport { candles: number; series: Array<{ symbol: string; tf: Timeframe; bars: number; error: string | null }> }

/** Load the deepest history Yahoo serves per timeframe (1m 7d, 5m/15m 60d, 1h 730d, 1d 5y). Failures are reported per series. */
export async function backfillCandles(store: Store, symbols: string[], tfs: Timeframe[], opts: { fetch?: FetchLike } = {}): Promise<BackfillReport> {
  const jobs = yahooCoverage(symbols).flatMap((symbol) => tfs.map((tf) => ({ symbol, tf })));
  const results = await mapLimit(jobs, 4, async ({ symbol, tf }) => {
    const candles = await yahooCandles(symbol, tf, BACKFILL_RANGE[tf], opts.fetch);
    if (candles.length) await store.upsertCandles(candles);
    return candles.length;
  });
  const series = results.map((r, i) => ({ ...(jobs[i] as { symbol: string; tf: Timeframe }), bars: r.ok ? r.value : 0, error: r.ok ? null : errText(r.error) }));
  return { candles: series.reduce((a, s) => a + s.bars, 0), series };
}
