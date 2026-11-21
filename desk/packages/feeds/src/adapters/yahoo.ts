/**
 * Yahoo Finance (free, unofficial, no key). v8 chart for candles and fallback quotes/yields; v7 options via the
 * cookie + crumb flow. CME/CBOT futures are delayed about 10 minutes: those items carry `meta.delayed`.
 */
import { DATUM_KEYS, INSTRUMENTS, TF_MS, iso, type Candle, type Datum, type Quote, type Timeframe } from '@desk/contracts';
import { BROWSER_UA, httpJson, httpText, mapLimit, settle } from '../http';
import { item, pollSubscribe, type Feed, type FeedCtx, type FeedItem, type FetchLike, type ItemOf } from '../types';
import { spread2s10s, volData } from './tradingview';

const BASE = 'https://query1.finance.yahoo.com';

export interface YahooChart {
  chart: { result: Array<{
    meta: { symbol: string; regularMarketPrice?: number; regularMarketTime?: number; chartPreviousClose?: number; previousClose?: number; instrumentType?: string };
    timestamp?: number[];
    indicators: { quote: Array<{ open: Array<number | null>; high: Array<number | null>; low: Array<number | null>; close: Array<number | null>; volume: Array<number | null> }> };
  }> | null; error?: { description?: string } | null };
}

export const yahooSymbolFor = (symbol: string): string | undefined => INSTRUMENTS[symbol]?.yahoo || undefined;
const isDelayed = (y: string): boolean => /=F$|\.CBT$|\.CME$|\.NYM$|\.CMX$/.test(y);
const delayMeta = (y: string): Record<string, unknown> | undefined => (isDelayed(y) ? { delayed: true, delayMin: 10 } : undefined);
const src = (y: string): string => (isDelayed(y) ? 'yahoo:delayed' : 'yahoo');

/** Desk symbols with their own Yahoo series (NQ-PERP tracks NQ and is skipped). */
export function yahooCoverage(symbols?: string[]): string[] {
  const all = symbols ?? Object.keys(INSTRUMENTS);
  return [...new Set(all.map((s) => INSTRUMENTS[s]?.priceSymbol ?? s))].filter((s) => yahooSymbolFor(s));
}

export async function fetchYahooChart(yahoo: string, interval: string, range: string, fetch?: FetchLike): Promise<YahooChart> {
  const res = await httpJson<YahooChart>(`${BASE}/v8/finance/chart/${encodeURIComponent(yahoo)}?interval=${interval}&range=${range}&includePrePost=true`, { fetch });
  if (!res.chart.result?.[0]) throw new Error(`Yahoo chart ${yahoo}: ${res.chart.error?.description ?? 'empty result'}`);
  return res;
}

/** Chart payload -> candles, ascending. Null bars and the unaligned in-progress row Yahoo appends are dropped. */
export function mapYahooChart(raw: YahooChart, symbol: string, tf: Timeframe, source = 'yahoo'): Candle[] {
  const r = raw.chart.result?.[0];
  const q = r?.indicators.quote[0];
  const ts = r?.timestamp ?? [];
  if (!q) return [];
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    const t = (ts[i] as number) * 1000;
    if (tf !== '1d' && t % TF_MS[tf] !== 0) continue;
    if (out.length && (out[out.length - 1] as Candle).t >= t) continue;
    out.push({ symbol, tf, t, o, h, l, c, v: q.volume[i] ?? 0, source });
  }
  return out;
}

export function mapYahooQuote(raw: YahooChart, symbol: string, cadenceSec: number, source = 'yahoo'): Quote | null {
  const m = raw.chart.result?.[0]?.meta;
  if (!m || typeof m.regularMarketPrice !== 'number' || typeof m.regularMarketTime !== 'number') return null;
  const prev = m.previousClose ?? m.chartPreviousClose ?? null;
  return { symbol, price: m.regularMarketPrice, prevClose: prev, changePct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : null, asOf: iso(m.regularMarketTime * 1000), source, cadenceSec };
}

const TF_INTERVAL: Record<Timeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '60m', '1d': '1d' };
/** Per-poll range (cheap) and backfill range (Yahoo's maximum for the interval). */
const POLL_RANGE: Record<Timeframe, string> = { '1m': '1d', '5m': '1d', '15m': '5d', '1h': '5d', '1d': '1mo' };
export const BACKFILL_RANGE: Record<Timeframe, string> = { '1m': '7d', '5m': '60d', '15m': '60d', '1h': '730d', '1d': '5y' };
const TF_CADENCE: Record<Timeframe, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 21_600 };

export async function yahooCandles(symbol: string, tf: Timeframe, range: string, fetch?: FetchLike): Promise<Candle[]> {
  const y = yahooSymbolFor(symbol);
  if (!y) return [];
  return mapYahooChart(await fetchYahooChart(y, TF_INTERVAL[tf], range, fetch), symbol, tf, src(y));
}

export function yahooCandleFeed(tf: Timeframe): Feed<ItemOf<'candle'>> {
  const feed: Feed<ItemOf<'candle'>> = {
    name: `yahoo.candles.${tf}`, kind: 'candles', live: false, requiresKey: null, cadenceSec: TF_CADENCE[tf], verified: true,
    enabled: () => true,
    async poll(ctx) {
      const results = await mapLimit(yahooCoverage(ctx.symbols), 6, (s) => yahooCandles(s, tf, POLL_RANGE[tf], ctx.fetch));
      return settle(results).flat().map((c) => item('candle', c, { source: c.source, asOf: iso(c.t + TF_MS[tf]), cadenceSec: TF_CADENCE[tf], symbol: c.symbol, meta: delayMeta(yahooSymbolFor(c.symbol) ?? '') }));
    },
  };
  feed.subscribe = pollSubscribe(feed);
  return feed;
}

export const yahooQuotes: Feed<ItemOf<'quote'>> = {
  name: 'yahoo.quotes', kind: 'quotes', live: false, requiresKey: null, cadenceSec: 60, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const results = await mapLimit(yahooCoverage(ctx.symbols), 6, async (s) => {
      const y = yahooSymbolFor(s) as string;
      return { s, y, q: mapYahooQuote(await fetchYahooChart(y, '1d', '1d', ctx.fetch), s, 60, src(y)) };
    });
    return settle(results).flatMap(({ s, y, q }) => (q ? [item('quote', q, { source: q.source, asOf: q.asOf, cadenceSec: 60, symbol: s, meta: delayMeta(y) })] : []));
  },
};
yahooQuotes.subscribe = pollSubscribe(yahooQuotes);

type YRate = 'US3M' | 'US5Y' | 'US10Y' | 'US30Y';
const YAHOO_RATES: YRate[] = ['US3M', 'US5Y', 'US10Y', 'US30Y'];

/** Yield series from CBOE rate indices (^IRX, ^FVX, ^TNX, ^TYX). No 2Y on Yahoo, so no 2s10s from this source alone. */
async function yahooRateSeries(sym: YRate, bars: number, ctx: FeedCtx, cadenceSec: number): Promise<Datum[]> {
  const candles = await yahooCandles(sym, '5m', '1d', ctx.fetch);
  return candles.slice(-bars).map((c) => ({ key: DATUM_KEYS.rate(sym), value: c.c, source: 'yahoo', asOf: iso(c.t + TF_MS['5m']), cadenceSec, meta: { tf: '5m' } }));
}
const datumItems = (data: Datum[]): Array<ItemOf<'datum'>> => data.map((d) => item('datum', d, { source: d.source, asOf: d.asOf, cadenceSec: d.cadenceSec, symbol: d.key }));

/** Fallback for the live rates slot: latest 5m close of each yield index. */
export const yahooRates: Feed<ItemOf<'datum'>> = {
  name: 'yahoo.rates', kind: 'rates', live: false, requiresKey: null, cadenceSec: 300, verified: true,
  enabled: () => true,
  async poll(ctx) {
    return datumItems(settle(await mapLimit(YAHOO_RATES, 4, (s) => yahooRateSeries(s, 1, ctx, 300))).flat());
  },
};

/**
 * Intraday yield history (last ~6.5h of 5m closes) so a 1h change is computable from the first ingest
 * instead of after an hour of polling. 2Y history only accrues from the live rates feed.
 */
export const yahooRatesHistory: Feed<ItemOf<'datum'>> = {
  name: 'yahoo.rates_history', kind: 'rates_history', live: false, requiresKey: null, cadenceSec: 300, verified: true,
  enabled: () => true,
  async poll(ctx) {
    return datumItems(settle(await mapLimit(YAHOO_RATES, 4, (s) => yahooRateSeries(s, 80, ctx, 300))).flat());
  },
};

export const yahooVol: Feed<ItemOf<'datum'>> = {
  name: 'yahoo.vol', kind: 'vol', live: false, requiresKey: null, cadenceSec: 300, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const qs = settle(await mapLimit(['VIX', 'VIX3M'], 2, async (s) => mapYahooQuote(await fetchYahooChart(yahooSymbolFor(s) as string, '1d', '1d', ctx.fetch), s, 300)));
    const pick = (s: string): { value: number; asOf: string; source: string } | undefined => { const q = qs.find((x) => x?.symbol === s); return q ? { value: q.price, asOf: q.asOf, source: q.source } : undefined; };
    return datumItems(volData(pick('VIX'), pick('VIX3M'), 300));
  },
};

/* ───────────── crumb session + options ───────────── */

interface Session { cookie: string; crumb: string; at: number }
let session: Session | null = null;
export const resetYahooSession = (): void => { session = null; };

/** Yahoo's consent cookie + crumb, cached for 30 minutes. fc.yahoo.com answers 404 but sets the cookie. */
export async function yahooSession(now: number, fetch?: FetchLike): Promise<Session> {
  if (session && now - session.at < 30 * 60_000 && now >= session.at) return session;
  const f = fetch ?? (globalThis.fetch as FetchLike);
  const res = await f('https://fc.yahoo.com/', { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(15_000) });
  await res.arrayBuffer();
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Yahoo session: no cookie issued');
  const crumb = (await httpText(`${BASE}/v1/test/getcrumb`, { fetch, headers: { Cookie: cookie } })).trim();
  if (!crumb || crumb.length > 40 || crumb.includes('<')) throw new Error('Yahoo session: no crumb');
  session = { cookie, crumb, at: now };
  return session;
}

export interface YahooOption { strike: number; lastPrice?: number; bid?: number; ask?: number; volume?: number; openInterest?: number; impliedVolatility?: number }
export interface YahooOptionChain {
  optionChain: { result: Array<{
    underlyingSymbol: string; expirationDates: number[];
    quote: { regularMarketPrice?: number; regularMarketTime?: number };
    options: Array<{ expirationDate: number; calls: YahooOption[]; puts: YahooOption[] }>;
  }> };
}

export async function fetchYahooOptions(yahoo: string, now: number, fetch?: FetchLike, expiry?: number): Promise<YahooOptionChain> {
  const s = await yahooSession(now, fetch);
  return httpJson<YahooOptionChain>(`${BASE}/v7/finance/options/${encodeURIComponent(yahoo)}?crumb=${encodeURIComponent(s.crumb)}${expiry ? `&date=${expiry}` : ''}`, { fetch, headers: { Cookie: s.cookie } });
}

const mid = (o: YahooOption): number | null => {
  if (o.bid && o.ask && o.ask >= o.bid) return (o.bid + o.ask) / 2;
  return o.lastPrice && o.lastPrice > 0 ? o.lastPrice : null;
};
/** Weekdays from now through the expiry date, at least 1 (holidays not netted out). */
export function tradingDaysTo(expirySec: number, now: number): number {
  let n = 0;
  for (let t = now; t < expirySec * 1000 + 21 * 3_600_000; t += 86_400_000) { const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
  return Math.max(1, n);
}

export interface ImpliedMove { symbol: string; movePct: number; days: number; oneDayPct: number; expiry: string; strike: number; spot: number; putCallVolume: number | null; putCallOi: number | null; asOf: string }

/** Implied move from the ATM straddle of the chain's first listed expiry: (call mid + put mid) / spot. */
export function impliedMoveFromChain(chain: YahooOptionChain, symbol: string, now: number): ImpliedMove | null {
  const r = chain.optionChain.result[0];
  const exp = r?.options[0];
  const spot = r?.quote.regularMarketPrice;
  if (!r || !exp || !spot) return null;
  const puts = new Map(exp.puts.map((p) => [p.strike, p]));
  const pairs = exp.calls.filter((c) => puts.has(c.strike)).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const call = pairs[0];
  if (!call) return null;
  const cm = mid(call), pm = mid(puts.get(call.strike) as YahooOption);
  if (cm === null || pm === null) return null;
  const sum = (xs: YahooOption[], k: 'volume' | 'openInterest'): number => xs.reduce((a, x) => a + (x[k] ?? 0), 0);
  const cv = sum(exp.calls, 'volume'), co = sum(exp.calls, 'openInterest');
  const days = tradingDaysTo(exp.expirationDate, now);
  const movePct = ((cm + pm) / spot) * 100;
  return {
    symbol, movePct, days, oneDayPct: movePct / Math.sqrt(days), expiry: iso(exp.expirationDate * 1000).slice(0, 10), strike: call.strike, spot,
    putCallVolume: cv > 0 ? sum(exp.puts, 'volume') / cv : null, putCallOi: co > 0 ? sum(exp.puts, 'openInterest') / co : null,
    asOf: iso((r.quote.regularMarketTime ?? Math.floor(now / 1000)) * 1000),
  };
}

/** Chain for the first expiry on or after `after` (epoch ms), else the nearest unexpired one. */
export async function yahooImpliedMove(symbol: string, now: number, fetch?: FetchLike, after?: number): Promise<ImpliedMove | null> {
  const y = yahooSymbolFor(symbol) ?? symbol;
  let chain = await fetchYahooOptions(y, now, fetch);
  const r = chain.optionChain.result[0];
  if (!r) return null;
  const want = r.expirationDates.find((e) => e * 1000 + 21 * 3_600_000 > (after ?? now));
  if (want && want !== r.options[0]?.expirationDate) chain = await fetchYahooOptions(y, now, fetch, want);
  return impliedMoveFromChain(chain, symbol, now);
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
export function impliedMoveData(m: ImpliedMove, source: string, cadenceSec: number, as = m.symbol, extra: Record<string, unknown> = {}): Datum[] {
  const out: Datum[] = [{
    key: DATUM_KEYS.impliedMove(as), value: r3(m.movePct), source, asOf: m.asOf, cadenceSec,
    meta: { method: 'options', days: m.days, oneDayPct: r3(m.oneDayPct), expiry: m.expiry, strike: m.strike, spot: m.spot, delayed: true, ...extra },
  }];
  if (m.putCallVolume !== null) out.push({ key: DATUM_KEYS.putCall(as), value: r3(m.putCallVolume), source, asOf: m.asOf, cadenceSec, meta: { basis: 'volume', expiry: m.expiry, oi: m.putCallOi === null ? null : r3(m.putCallOi), ...extra } });
  return out;
}

/** NQ fallback when no chain is available: VIX / sqrt(252), labelled `vix`. */
export function vixImpliedMove(vix: Datum): Datum {
  return { key: DATUM_KEYS.impliedMove('NQ'), value: r3(vix.value / Math.sqrt(252)), source: vix.source, asOf: vix.asOf, cadenceSec: vix.cadenceSec, meta: { method: 'vix', days: 1, vix: vix.value, note: 'VIX is S&P 500 vol; NQ usually moves more' } };
}

/**
 * opt.implied_move.<SYMBOL> and opt.put_call.<SYMBOL> for the watchlist, and NQ via the QQQ chain.
 * If the QQQ chain fails, NQ falls back to VIX/sqrt(252) from the Yahoo ^VIX quote.
 */
export const yahooOptions: Feed<ItemOf<'datum'>> = {
  name: 'yahoo.options', kind: 'options', live: false, requiresKey: null, cadenceSec: 1800, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const stocks = (ctx.symbols ?? Object.keys(INSTRUMENTS)).filter((s) => INSTRUMENTS[s]?.kind === 'stock' && INSTRUMENTS[s]?.tradable);
    const results = await mapLimit([...new Set([...stocks, 'QQQ'])], 3, (s) => yahooImpliedMove(s, ctx.now, ctx.fetch));
    const data: Datum[] = [];
    let nq = false;
    for (const r of results) {
      if (!r.ok || !r.value) continue;
      data.push(...impliedMoveData(r.value, 'yahoo:options', 1800));
      if (r.value.symbol === 'QQQ') { data.push(...impliedMoveData(r.value, 'yahoo:options', 1800, 'NQ', { proxy: 'QQQ' })); nq = true; }
    }
    if (!nq) {
      const q = mapYahooQuote(await fetchYahooChart('^VIX', '1d', '1d', ctx.fetch), 'VIX', 1800);
      if (q) data.push(vixImpliedMove({ key: DATUM_KEYS.vix, value: q.price, source: q.source, asOf: q.asOf, cadenceSec: 1800 }));
    }
    if (data.length === 0) { const bad = results.find((r) => !r.ok); if (bad && !bad.ok) throw bad.error; }
    return datumItems(data);
  },
};

/** Yield spread helper re-exported for callers that only import the Yahoo module. */
export { spread2s10s };
export type YahooItem = FeedItem;
