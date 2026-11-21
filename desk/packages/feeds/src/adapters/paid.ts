/**
 * Paid and flagged adapters. Every one is OFF unless its env key (or flag) is set, sits ahead of the free
 * provider in the registry when on, and was written against the provider's documented API.
 * NONE of these has been exercised against the live service: `verified: false`. Their response mappers
 * are unit-tested on hand-written payloads in the documented shape.
 */
import { DATUM_KEYS, DAY, INSTRUMENTS, TF_MS, hashId, iso, type CalendarEvent, type Candle, type Datum, type Quote, type Timeframe } from '@desk/contracts';
import { titleToEventCode } from '../calendar-codes';
import { classifyHeadlines, type RawHeadline } from '../headlines';
import { httpJson, httpText, mapLimit, settle } from '../http';
import { llmFromEnv } from '../llm';
import { flagOn, item, pollSubscribe, type Feed, type FeedCtx, type ItemOf } from '../types';
import { impliedMoveData, impliedMoveFromChain, type YahooOption, type YahooOptionChain } from './yahoo';

const stocks = (ctx: FeedCtx): string[] => (ctx.symbols ?? Object.keys(INSTRUMENTS)).filter((s) => INSTRUMENTS[s]?.kind === 'stock');
const quoteItem = (q: Quote): ItemOf<'quote'> => item('quote', q, { source: q.source, asOf: q.asOf, cadenceSec: q.cadenceSec, symbol: q.symbol });
const pct = (p: number, prev: number | null): number | null => (prev ? ((p - prev) / prev) * 100 : null);

/* ───────────── Polygon (POLYGON_API_KEY): stock snapshots, aggregates, websocket ───────────── */

export interface PolygonSnapshot { tickers?: Array<{ ticker: string; lastTrade?: { p: number; t: number }; prevDay?: { c: number }; todaysChangePerc?: number; updated?: number }> }
export function mapPolygonSnapshot(res: PolygonSnapshot): Quote[] {
  return (res.tickers ?? []).flatMap((t) => (t.lastTrade ? [{
    symbol: t.ticker, price: t.lastTrade.p, prevClose: t.prevDay?.c ?? null, changePct: t.todaysChangePerc ?? null,
    asOf: iso(Math.round((t.lastTrade.t ?? t.updated ?? 0) / 1e6)), source: 'polygon', cadenceSec: 5,
  }] : []));
}
export interface PolygonAggs { results?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> }
export function mapPolygonAggs(res: PolygonAggs, symbol: string, tf: Timeframe): Candle[] {
  return (res.results ?? []).map((r) => ({ symbol, tf, t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, source: 'polygon' }));
}
/** Websocket per-second aggregate events: `[{ev:"A", sym, c, s, e}]`. */
export function mapPolygonWs(msg: unknown): Quote[] {
  const arr = Array.isArray(msg) ? (msg as Array<Record<string, unknown>>) : [];
  return arr.flatMap((m) => (m.ev === 'A' && typeof m.sym === 'string' && typeof m.c === 'number' && typeof m.e === 'number'
    ? [{ symbol: m.sym, price: m.c, prevClose: null, changePct: null, asOf: iso(m.e), source: 'polygon:ws', cadenceSec: 1 }] : []));
}
const POLY_SPAN: Record<Timeframe, [number, string]> = { '1m': [1, 'minute'], '5m': [5, 'minute'], '15m': [15, 'minute'], '1h': [1, 'hour'], '1d': [1, 'day'] };
export async function polygonCandles(symbol: string, tf: Timeframe, fromMs: number, toMs: number, ctx: Pick<FeedCtx, 'env' | 'fetch'>): Promise<Candle[]> {
  const [mult, span] = POLY_SPAN[tf];
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${mult}/${span}/${fromMs}/${toMs}?adjusted=true&sort=asc&limit=50000&apiKey=${ctx.env.POLYGON_API_KEY ?? ''}`;
  return mapPolygonAggs(await httpJson<PolygonAggs>(url, { fetch: ctx.fetch }), symbol, tf);
}
export const polygonQuotes: Feed<ItemOf<'quote'>> = {
  name: 'polygon.quotes', kind: 'quotes', live: true, requiresKey: 'POLYGON_API_KEY', cadenceSec: 60, verified: false,
  enabled: (env) => !!env.POLYGON_API_KEY,
  async poll(ctx) {
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${stocks(ctx).join(',')}&apiKey=${ctx.env.POLYGON_API_KEY ?? ''}`;
    return mapPolygonSnapshot(await httpJson<PolygonSnapshot>(url, { fetch: ctx.fetch })).map(quoteItem);
  },
  /** Streaming per-second aggregates over wss://socket.polygon.io/stocks. `topic` is a ticker or '*'. */
  subscribe(topic, onData, opts) {
    const ws = new WebSocket('wss://socket.polygon.io/stocks');
    ws.addEventListener('open', () => ws.send(JSON.stringify({ action: 'auth', params: opts.env.POLYGON_API_KEY ?? '' })));
    ws.addEventListener('message', (ev) => {
      try {
        const msg: unknown = JSON.parse(String(ev.data));
        if (Array.isArray(msg) && msg.some((m: { ev?: string; status?: string }) => m.ev === 'status' && m.status === 'auth_success')) ws.send(JSON.stringify({ action: 'subscribe', params: `A.${topic}` }));
        const quotes = mapPolygonWs(msg);
        if (quotes.length) onData(quotes.map(quoteItem));
      } catch (e) { opts.onError?.(e instanceof Error ? e : new Error(String(e))); }
    });
    ws.addEventListener('error', () => opts.onError?.(new Error('polygon websocket error')));
    return () => ws.close();
  },
};
export const polygonCandleFeed: Feed<ItemOf<'candle'>> = {
  name: 'polygon.candles.1m', kind: 'candles', live: true, requiresKey: 'POLYGON_API_KEY', cadenceSec: 60, verified: false,
  enabled: (env) => !!env.POLYGON_API_KEY,
  async poll(ctx) {
    const per = await mapLimit(stocks(ctx), 4, (s) => polygonCandles(s, '1m', ctx.now - 2 * 3_600_000, ctx.now, ctx));
    return settle(per).flat().map((c) => item('candle', c, { source: 'polygon', asOf: iso(c.t + TF_MS['1m']), cadenceSec: 60, symbol: c.symbol }));
  },
};

/* ───────────── Databento (DATABENTO_API_KEY): CME futures OHLCV, historical HTTP API ─────────────
 * Live data uses Databento's raw TCP gateway (Live Subscription Gateway), not HTTP; wiring that needs their
 * client library, which is not a dependency here. This adapter polls the historical API, which lags real time
 * by the dataset's embargo unless the plan includes intraday history. */

const DBN_ROOT: Record<string, string> = { NQ: 'NQ', MNQ: 'MNQ', ES: 'ES', YM: 'YM', RTY: 'RTY', CL: 'CL', GC: 'GC', ZN: 'ZN', ZT: 'ZT', ZQ: 'ZQ' };
const DBN_SCHEMA: Partial<Record<Timeframe, string>> = { '1m': 'ohlcv-1m', '1h': 'ohlcv-1h', '1d': 'ohlcv-1d' };
/** NDJSON with pretty_px/pretty_ts: `{"hd":{"ts_event":"2026-11-20T14:30:00.000000000Z"},"open":"25100.25",...}`. */
export function mapDatabentoOhlcv(ndjson: string, symbol: string, tf: Timeframe): Candle[] {
  const out: Candle[] = [];
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { hd?: { ts_event?: string }; open?: string; high?: string; low?: string; close?: string; volume?: string | number };
    const t = Date.parse(r.hd?.ts_event ?? ''), o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close);
    if ([t, o, h, l, c].every(Number.isFinite)) out.push({ symbol, tf, t, o, h, l, c, v: Number(r.volume ?? 0), source: 'databento' });
  }
  return out.sort((a, b) => a.t - b.t);
}
export async function databentoCandles(symbol: string, tf: Timeframe, fromMs: number, toMs: number, ctx: Pick<FeedCtx, 'env' | 'fetch'>): Promise<Candle[]> {
  const root = DBN_ROOT[symbol], schema = DBN_SCHEMA[tf];
  if (!root || !schema) return [];
  const q = new URLSearchParams({ dataset: 'GLBX.MDP3', symbols: `${root}.c.0`, stype_in: 'continuous', schema, start: iso(fromMs), end: iso(toMs), encoding: 'json', pretty_px: 'true', pretty_ts: 'true' });
  const auth = `Basic ${Buffer.from(`${ctx.env.DATABENTO_API_KEY ?? ''}:`).toString('base64')}`;
  return mapDatabentoOhlcv(await httpText(`https://hist.databento.com/v0/timeseries.get_range?${q.toString()}`, { fetch: ctx.fetch, headers: { Authorization: auth }, timeoutMs: 30_000 }), symbol, tf);
}
export const databentoCandleFeed: Feed<ItemOf<'candle'>> = {
  name: 'databento.candles.1m', kind: 'candles', live: true, requiresKey: 'DATABENTO_API_KEY', cadenceSec: 60, verified: false,
  enabled: (env) => !!env.DATABENTO_API_KEY,
  async poll(ctx) {
    const syms = (ctx.symbols ?? Object.keys(DBN_ROOT)).filter((s) => DBN_ROOT[s]);
    const per = await mapLimit(syms, 4, (s) => databentoCandles(s, '1m', ctx.now - 2 * 3_600_000, ctx.now, ctx));
    return settle(per).flat().map((c) => item('candle', c, { source: 'databento', asOf: iso(c.t + TF_MS['1m']), cadenceSec: 60, symbol: c.symbol }));
  },
};

/* ───────────── Tradier (TRADIER_API_KEY) ───────────── */

interface TradierQuote { symbol: string; last: number | null; prevclose: number | null; change_percentage: number | null; trade_date: number }
export interface TradierQuotes { quotes?: { quote?: TradierQuote | TradierQuote[] } }
export function mapTradierQuotes(res: TradierQuotes): Quote[] {
  const q = res.quotes?.quote;
  return (Array.isArray(q) ? q : q ? [q] : []).flatMap((x) => (typeof x.last === 'number'
    ? [{ symbol: x.symbol, price: x.last, prevClose: x.prevclose, changePct: x.change_percentage, asOf: iso(x.trade_date), source: 'tradier', cadenceSec: 60 }] : []));
}
export const tradierQuotes: Feed<ItemOf<'quote'>> = {
  name: 'tradier.quotes', kind: 'quotes', live: true, requiresKey: 'TRADIER_API_KEY', cadenceSec: 60, verified: false,
  enabled: (env) => !!env.TRADIER_API_KEY,
  async poll(ctx) {
    const res = await httpJson<TradierQuotes>(`https://api.tradier.com/v1/markets/quotes?symbols=${stocks(ctx).join(',')}`, { fetch: ctx.fetch, headers: { Authorization: `Bearer ${ctx.env.TRADIER_API_KEY ?? ''}`, Accept: 'application/json' } });
    return mapTradierQuotes(res).map(quoteItem);
  },
};
tradierQuotes.subscribe = pollSubscribe(tradierQuotes);

/* ───────────── Alpaca (ALPACA_API_KEY + ALPACA_API_SECRET) ───────────── */

export type AlpacaSnapshots = Record<string, { latestTrade?: { t: string; p: number }; prevDailyBar?: { c: number } }>;
export function mapAlpacaSnapshots(res: AlpacaSnapshots): Quote[] {
  return Object.entries(res).flatMap(([symbol, s]) => (s.latestTrade
    ? [{ symbol, price: s.latestTrade.p, prevClose: s.prevDailyBar?.c ?? null, changePct: pct(s.latestTrade.p, s.prevDailyBar?.c ?? null), asOf: new Date(s.latestTrade.t).toISOString(), source: 'alpaca', cadenceSec: 60 }] : []));
}
export const alpacaQuotes: Feed<ItemOf<'quote'>> = {
  name: 'alpaca.quotes', kind: 'quotes', live: true, requiresKey: 'ALPACA_API_KEY', cadenceSec: 60, verified: false,
  enabled: (env) => !!env.ALPACA_API_KEY && !!env.ALPACA_API_SECRET,
  async poll(ctx) {
    const res = await httpJson<AlpacaSnapshots>(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${stocks(ctx).join(',')}`, { fetch: ctx.fetch, headers: { 'APCA-API-KEY-ID': ctx.env.ALPACA_API_KEY ?? '', 'APCA-API-SECRET-KEY': ctx.env.ALPACA_API_SECRET ?? '' } });
    return mapAlpacaSnapshots(res).map(quoteItem);
  },
};
alpacaQuotes.subscribe = pollSubscribe(alpacaQuotes);

/* ───────────── Trading Economics calendar (TRADING_ECONOMICS_KEY) ───────────── */

export interface TeRow { CalendarId: string | number; Date: string; Event: string; Actual?: string | null; Previous?: string | null; Forecast?: string | null; TEForecast?: string | null; Revised?: string | null; Importance?: number; Unit?: string | null }
const teNum = (s: string | null | undefined): number | null => { const m = /-?\d+(?:\.\d+)?/.exec((s ?? '').replace(/,/g, '')); return m ? Number(m[0]) : null; };
/** TE dates are UTC without a zone suffix; Importance 1-3 maps to the contract's -1..1. Consensus is `Forecast`, never TE's own model forecast. */
export function mapTradingEconomics(rows: TeRow[], asOf: string): CalendarEvent[] {
  return rows.map((r) => ({
    id: `te_${r.CalendarId}`, code: titleToEventCode(r.Event), name: r.Event, time: new Date(/Z|[+-]\d\d:?\d\d$/.test(r.Date) ? r.Date : `${r.Date}Z`).toISOString(),
    consensus: teNum(r.Forecast), prior: teNum(r.Previous), actual: teNum(r.Actual), revisedPrior: teNum(r.Revised),
    ...(r.Unit ? { unit: r.Unit } : {}), importance: (r.Importance ?? 2) - 2, source: 'tradingeconomics', asOf,
  }));
}
export const tradingEconomics: Feed<ItemOf<'calendar'>> = {
  name: 'tradingeconomics.calendar', kind: 'calendar', live: true, requiresKey: 'TRADING_ECONOMICS_KEY', cadenceSec: 300, verified: false,
  enabled: (env) => !!env.TRADING_ECONOMICS_KEY,
  async poll(ctx) {
    const d = (t: number): string => iso(t).slice(0, 10);
    const url = `https://api.tradingeconomics.com/calendar/country/united%20states/${d(ctx.now - DAY)}/${d(ctx.now + 42 * DAY)}?c=${ctx.env.TRADING_ECONOMICS_KEY ?? ''}&f=json`;
    const asOf = iso(ctx.now);
    return mapTradingEconomics(await httpJson<TeRow[]>(url, { fetch: ctx.fetch }), asOf).map((e) => item('calendar', e, { source: e.source, asOf, cadenceSec: 300 }));
  },
};

/* ───────────── Benzinga news + analyst ratings (BENZINGA_API_KEY) ───────────── */

export interface BenzingaNews { id: number; title: string; created: string; url?: string }
export function mapBenzingaNews(rows: BenzingaNews[]): RawHeadline[] {
  return rows.flatMap((r) => { const t = Date.parse(r.created); return Number.isNaN(t) ? [] : [{ title: r.title, ts: iso(t), source: 'benzinga', ...(r.url ? { url: r.url } : {}) }]; });
}
export interface BenzingaRatings { ratings?: Array<{ id: string; date: string; time?: string; ticker: string; analyst?: string; action_company?: string; rating_current?: string; rating_prior?: string; pt_current?: string; pt_prior?: string }> }
/** Ratings become company headlines ("Morgan Stanley upgrades NVDA to Overweight, PT 180 from 160"). `date`/`time` are US Eastern. */
export function mapBenzingaRatings(res: BenzingaRatings): RawHeadline[] {
  return (res.ratings ?? []).map((r) => {
    const pt = r.pt_current ? `, PT ${r.pt_current}${r.pt_prior ? ` from ${r.pt_prior}` : ''}` : '';
    return { title: `${r.analyst ?? 'Analyst'} ${(r.action_company ?? 'rates').toLowerCase()} ${r.ticker}${r.rating_current ? ` to ${r.rating_current}` : ''}${pt}`, ts: new Date(`${r.date}T${r.time ?? '12:00:00'}-05:00`).toISOString(), source: 'benzinga:ratings' };
  });
}
const benzinga = (name: string, kind: 'headlines' | 'ratings', path: (ctx: FeedCtx) => string, map: (body: unknown) => RawHeadline[]): Feed<ItemOf<'headline'>> => ({
  name, kind, live: true, requiresKey: 'BENZINGA_API_KEY', cadenceSec: kind === 'headlines' ? 60 : 3600, verified: false,
  enabled: (env) => !!env.BENZINGA_API_KEY,
  async poll(ctx) {
    const raws = map(await httpJson<unknown>(`https://api.benzinga.com${path(ctx)}`, { fetch: ctx.fetch, headers: { Accept: 'application/json' } }));
    return (await classifyHeadlines(raws, llmFromEnv(ctx.env))).map((h) => item('headline', h, { source: h.source, asOf: h.ts, cadenceSec: 60 }));
  },
});
export const benzingaNews = benzinga('benzinga.news', 'headlines', (ctx) => `/api/v2/news?token=${ctx.env.BENZINGA_API_KEY ?? ''}&pageSize=50&displayOutput=headline`, (b) => mapBenzingaNews(b as BenzingaNews[]));
export const benzingaRatings = benzinga('benzinga.ratings', 'ratings', (ctx) => `/api/v2.1/calendar/ratings?token=${ctx.env.BENZINGA_API_KEY ?? ''}&parameters[tickers]=${stocks(ctx).join(',')}`, (b) => mapBenzingaRatings(b as BenzingaRatings));

/* ───────────── FRED daily Treasury yields (FRED_API_KEY; the host timed out from the build container) ───────────── */

const FRED_SERIES = { DGS3MO: 'US3M', DGS2: 'US2Y', DGS5: 'US5Y', DGS10: 'US10Y', DGS30: 'US30Y' } as const;
export interface FredObservations { observations?: Array<{ date: string; value: string }> }
/** Latest non-missing observation ("." marks a holiday). Daily data: as-of is the observation date. */
export function mapFred(res: FredObservations, sym: (typeof FRED_SERIES)[keyof typeof FRED_SERIES]): Datum | null {
  const o = [...(res.observations ?? [])].sort((a, b) => b.date.localeCompare(a.date)).find((x) => Number.isFinite(Number(x.value)));
  return o ? { key: DATUM_KEYS.rate(sym), value: Number(o.value), source: 'fred', asOf: `${o.date}T21:00:00.000Z`, cadenceSec: 86_400, meta: { daily: true } } : null;
}
export const fredRates: Feed<ItemOf<'datum'>> = {
  name: 'fred.rates', kind: 'rates', live: false, requiresKey: 'FRED_API_KEY', cadenceSec: 3600, verified: false,
  enabled: (env) => !!env.FRED_API_KEY,
  async poll(ctx) {
    const per = await mapLimit(Object.entries(FRED_SERIES), 3, async ([id, sym]) =>
      mapFred(await httpJson<FredObservations>(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${ctx.env.FRED_API_KEY ?? ''}&file_type=json&sort_order=desc&limit=5`, { fetch: ctx.fetch }), sym));
    return settle(per).flatMap((d) => (d ? [item('datum', d, { source: 'fred', asOf: d.asOf, cadenceSec: 86_400, symbol: d.key })] : []));
  },
};

/* ───────────── Flagged free sources that are blocked from the build container ───────────── */

/** Binance spot 24h ticker (FEED_BINANCE=1). Returned HTTP 451 from the build container. */
export interface BinanceTicker { symbol: string; lastPrice: string; prevClosePrice: string; priceChangePercent: string; closeTime: number }
export function mapBinanceTicker(t: BinanceTicker, symbol: string): Quote {
  return { symbol, price: Number(t.lastPrice), prevClose: Number(t.prevClosePrice), changePct: Number(t.priceChangePercent), asOf: iso(t.closeTime), source: 'binance', cadenceSec: 60 };
}
export const binance: Feed<ItemOf<'quote'>> = {
  name: 'binance', kind: 'crypto', live: true, requiresKey: null, cadenceSec: 60, verified: false,
  enabled: (env) => flagOn(env, 'FEED_BINANCE'),
  async poll(ctx) {
    const per = await mapLimit((ctx.symbols ?? ['BTC', 'ETH']).filter((s) => s === 'BTC' || s === 'ETH'), 2, async (s) => mapBinanceTicker(await httpJson<BinanceTicker>(`https://api.binance.com/api/v3/ticker/24hr?symbol=${s}USDT`, { fetch: ctx.fetch }), s));
    return settle(per).map(quoteItem);
  },
};

/** CBOE delayed option quotes (FEED_CBOE=1). Cloudflare answered 403 from the build container. */
export interface CboeChain { timestamp?: string; data?: { current_price?: number; options?: Array<{ option: string; bid?: number; ask?: number; last_trade_price?: number; volume?: number; open_interest?: number }> } }
/** OCC symbols ("NVDA261123C00146000") -> the Yahoo chain shape, nearest unexpired expiry only, so one straddle routine serves both. */
export function cboeToChain(res: CboeChain, symbol: string, now: number): YahooOptionChain | null {
  const rows = (res.data?.options ?? []).flatMap((o) => {
    const m = /(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(o.option);
    if (!m) return [];
    const exp = Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
    const opt: YahooOption = { strike: Number(m[5]) / 1000, bid: o.bid, ask: o.ask, lastPrice: o.last_trade_price, volume: o.volume, openInterest: o.open_interest };
    return [{ exp, call: m[4] === 'C', opt }];
  });
  const expiries = [...new Set(rows.map((r) => r.exp))].sort((a, b) => a - b);
  const exp = expiries.find((e) => e * 1000 + 21 * 3_600_000 > now);
  if (exp === undefined || !res.data?.current_price) return null;
  const at = rows.filter((r) => r.exp === exp);
  const ts = Date.parse(`${(res.timestamp ?? '').replace(' ', 'T')}Z`);
  return { optionChain: { result: [{ underlyingSymbol: symbol, expirationDates: expiries, quote: { regularMarketPrice: res.data.current_price, regularMarketTime: Math.floor((Number.isNaN(ts) ? now : ts) / 1000) }, options: [{ expirationDate: exp, calls: at.filter((r) => r.call).map((r) => r.opt), puts: at.filter((r) => !r.call).map((r) => r.opt) }] }] } };
}
export const cboeOptions: Feed<ItemOf<'datum'>> = {
  name: 'cboe.options', kind: 'options', live: false, requiresKey: null, cadenceSec: 1800, verified: false,
  enabled: (env) => flagOn(env, 'FEED_CBOE'),
  async poll(ctx) {
    const per = await mapLimit([...new Set([...stocks(ctx).filter((s) => INSTRUMENTS[s]?.tradable), 'QQQ'])], 3, async (s) => {
      const chain = cboeToChain(await httpJson<CboeChain>(`https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`, { fetch: ctx.fetch }), s, ctx.now);
      const m = chain ? impliedMoveFromChain(chain, s, ctx.now) : null;
      return m ? [...impliedMoveData(m, 'cboe:delayed', 1800), ...(s === 'QQQ' ? impliedMoveData(m, 'cboe:delayed', 1800, 'NQ', { proxy: 'QQQ' }) : [])] : [];
    });
    return settle(per).flat().map((d) => item('datum', d, { source: d.source, asOf: d.asOf, cadenceSec: 1800, symbol: d.key }));
  },
};

/**
 * Spot-bitcoin ETF flows from Farside's public table (FEED_ETF_FLOWS=1), IBIT only. Farside answered a
 * Cloudflare challenge from the build container, so the table layout assumed here (a header row of tickers,
 * then one row per day "20 Nov 2026" with US$m per fund, negatives in parentheses) has not been checked.
 * No free source was found for QQQ / SOXX / GLD flows; those keys stay unwritten.
 */
export function mapFarsideFlows(html: string, ticker: string): Array<{ date: string; usdMm: number }> {
  const rows = [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((r) => [...r[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => (c[1] ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()));
  const col = rows.find((r) => r.includes(ticker))?.indexOf(ticker) ?? -1;
  if (col < 0) return [];
  return rows.flatMap((r) => {
    const t = Date.parse(`${r[0] ?? ''} UTC`), cell = (r[col] ?? '').replace(/,/g, '');
    const m = /^\(?(-?\d+(?:\.\d+)?)\)?$/.exec(cell);
    return /^\d{1,2} [A-Za-z]{3} \d{4}$/.test(r[0] ?? '') && !Number.isNaN(t) && m ? [{ date: iso(t).slice(0, 10), usdMm: Number(m[1]) * (cell.startsWith('(') ? -1 : 1) }] : [];
  });
}
export const etfFlows: Feed<ItemOf<'datum'>> = {
  name: 'farside.etf_flows', kind: 'flows', live: false, requiresKey: null, cadenceSec: 21_600, verified: false,
  enabled: (env) => flagOn(env, 'FEED_ETF_FLOWS'),
  async poll(ctx) {
    const last = mapFarsideFlows(await httpText('https://farside.co.uk/bitcoin-etf-flow-all-data/', { fetch: ctx.fetch, headers: { Accept: 'text/html' } }), 'IBIT').sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!last) throw new Error('Farside: no IBIT row parsed');
    const d: Datum = { key: DATUM_KEYS.etfFlow('IBIT'), value: last.usdMm, source: 'farside', asOf: `${last.date}T21:00:00.000Z`, cadenceSec: 86_400, meta: { date: last.date } };
    return [item('datum', d, { source: 'farside', asOf: d.asOf, cadenceSec: 86_400, symbol: d.key })];
  },
};

export const ratingId = (r: { id: string }): string => hashId('bz', r.id);
