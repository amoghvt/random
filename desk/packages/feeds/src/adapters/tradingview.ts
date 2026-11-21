/**
 * TradingView public endpoints (free, no key): scanner for quotes/yields/vol, and the economic calendar.
 * CME/CBOT/CBOE symbols are delayed 10-15 minutes on this tier (`update_mode`), TVC yields and DXY stream.
 */
import { DATUM_KEYS, DAY, INSTRUMENTS, TF_MS, iso, type CalendarEvent, type Candle, type Datum, type Quote, type Timeframe } from '@desk/contracts';
import { titleToEventCode } from '../calendar-codes';
import { httpJson } from '../http';
import { item, pollSubscribe, type Feed, type FeedCtx, type FetchLike, type ItemOf } from '../types';

const SCAN_URL = 'https://scanner.tradingview.com/global/scan';
const CALENDAR_URL = 'https://economic-calendar.tradingview.com/events';

const NASDAQ = ['NVDA', 'AMZN', 'INTC', 'CRWV', 'NBIS', 'SNDK', 'TTWO', 'AMD', 'AVGO', 'MU', 'QQQ', 'SOXX', 'IBIT'];
const AMEX = ['SPY', 'RSP', 'XLP', 'XLU', 'GLD'];
/** Desk symbol -> TradingView ticker. Anything absent here falls through to the next quote provider. */
export const TV_SYMBOLS: Record<string, string> = {
  NQ: 'CME_MINI:NQ1!', MNQ: 'CME_MINI:MNQ1!', ES: 'CME_MINI:ES1!', YM: 'CBOT_MINI:YM1!', RTY: 'CME_MINI:RTY1!',
  CL: 'NYMEX:CL1!', GC: 'COMEX:GC1!', ZT: 'CBOT:ZT1!', ZN: 'CBOT:ZN1!', ZQ: 'CBOT:ZQ1!',
  SOX: 'NASDAQ:SOX', NDX: 'NASDAQ:NDX', VIX: 'CBOE:VIX', VIX3M: 'CBOE:VIX3M', DXY: 'TVC:DXY',
  US3M: 'TVC:US03MY', US2Y: 'TVC:US02Y', US5Y: 'TVC:US05Y', US10Y: 'TVC:US10Y', US30Y: 'TVC:US30Y',
  BTC: 'COINBASE:BTCUSD', ETH: 'COINBASE:ETHUSD', TSM: 'NYSE:TSM',
  ...Object.fromEntries(NASDAQ.map((s) => [s, `NASDAQ:${s}`])), ...Object.fromEntries(AMEX.map((s) => [s, `AMEX:${s}`])),
};

export interface TvScanResponse { totalCount: number; data: Array<{ s: string; d: Array<string | number | null> }> }
export interface TvRow { ticker: string; close: number; changePct: number | null; changeAbs: number | null; asOf: string; delaySec: number; description: string }

const QUOTE_COLUMNS = ['close', 'change', 'change_abs', 'last_bar_update_time', 'update_mode', 'description'];

export async function tvScan(tickers: string[], columns: string[], fetch?: FetchLike): Promise<TvScanResponse> {
  return httpJson<TvScanResponse>(SCAN_URL, { fetch, body: { symbols: { tickers }, columns } });
}

/** Rows for QUOTE_COLUMNS. `update_mode` is "streaming" or "delayed_streaming_<sec>". */
export function mapTvScan(res: TvScanResponse, now: number): TvRow[] {
  const out: TvRow[] = [];
  for (const r of res.data) {
    const [close, change, changeAbs, t, mode, desc] = r.d;
    if (typeof close !== 'number') continue;
    const delay = typeof mode === 'string' ? Number(/delayed_streaming_(\d+)/.exec(mode)?.[1] ?? 0) : 0;
    out.push({
      ticker: r.s, close, changePct: typeof change === 'number' ? change : null, changeAbs: typeof changeAbs === 'number' ? changeAbs : null,
      asOf: iso(typeof t === 'number' ? t * 1000 : now), delaySec: delay, description: typeof desc === 'string' ? desc : r.s,
    });
  }
  return out;
}

const tvSource = (r: TvRow): string => (r.delaySec ? `tradingview:delayed${Math.round(r.delaySec / 60)}m` : 'tradingview');
const tvMeta = (r: TvRow): Record<string, unknown> | undefined => (r.delaySec ? { delayed: true, delayMin: Math.round(r.delaySec / 60) } : undefined);

async function scanDesk(symbols: string[], ctx: FeedCtx): Promise<Array<{ symbol: string; row: TvRow }>> {
  const want = symbols.filter((s) => TV_SYMBOLS[s]);
  if (want.length === 0) return [];
  const rows = mapTvScan(await tvScan(want.map((s) => TV_SYMBOLS[s] as string), QUOTE_COLUMNS, ctx.fetch), ctx.now);
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  return want.flatMap((symbol) => { const row = byTicker.get(TV_SYMBOLS[symbol] as string); return row ? [{ symbol, row }] : []; });
}

export function tvRowToQuote(symbol: string, r: TvRow, cadenceSec: number): Quote {
  return { symbol, price: r.close, prevClose: r.changeAbs === null ? null : r.close - r.changeAbs, changePct: r.changePct, asOf: r.asOf, source: tvSource(r), cadenceSec };
}

const quoteSymbols = (ctx: FeedCtx): string[] => [...new Set((ctx.symbols ?? Object.keys(INSTRUMENTS)).map((s) => INSTRUMENTS[s]?.priceSymbol ?? s))];

export const tradingViewQuotes: Feed<ItemOf<'quote'>> = {
  name: 'tradingview.quotes', kind: 'quotes', live: true, requiresKey: null, cadenceSec: 60, verified: true,
  enabled: () => true,
  async poll(ctx) {
    return (await scanDesk(quoteSymbols(ctx), ctx)).map(({ symbol, row }) => {
      const q = tvRowToQuote(symbol, row, 60);
      return item('quote', q, { source: q.source, asOf: q.asOf, cadenceSec: 60, symbol, meta: tvMeta(row) });
    });
  },
};
tradingViewQuotes.subscribe = pollSubscribe(tradingViewQuotes);

type RateSym = 'US2Y' | 'US10Y' | 'US30Y' | 'US3M' | 'US5Y';
const RATE_SYMS: RateSym[] = ['US3M', 'US2Y', 'US5Y', 'US10Y', 'US30Y'];

/** 2s10s in bp from two yield data; as-of is the older leg. */
export function spread2s10s(y2: Datum, y10: Datum): Datum {
  return {
    key: DATUM_KEYS.spread2s10s, value: Math.round((y10.value - y2.value) * 1000) / 10, source: y10.source === y2.source ? y10.source : `${y2.source}+${y10.source}`,
    asOf: y2.asOf < y10.asOf ? y2.asOf : y10.asOf, cadenceSec: Math.max(y2.cadenceSec, y10.cadenceSec), meta: { y2: y2.value, y10: y10.value },
  };
}

export const tradingViewRates: Feed<ItemOf<'datum'>> = {
  name: 'tradingview.rates', kind: 'rates', live: true, requiresKey: null, cadenceSec: 60, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const data = (await scanDesk(RATE_SYMS, ctx)).map(({ symbol, row }): Datum => ({
      key: DATUM_KEYS.rate(symbol as RateSym), value: row.close, source: tvSource(row), asOf: row.asOf, cadenceSec: 60,
      meta: { ...tvMeta(row), ...(row.changeAbs === null ? {} : { chg1dBp: Math.round(row.changeAbs * 1000) / 10 }) },
    }));
    const y2 = data.find((d) => d.key === DATUM_KEYS.rate('US2Y')), y10 = data.find((d) => d.key === DATUM_KEYS.rate('US10Y'));
    if (y2 && y10) data.push(spread2s10s(y2, y10));
    return data.map((d) => item('datum', d, { source: d.source, asOf: d.asOf, cadenceSec: d.cadenceSec, symbol: d.key }));
  },
};
tradingViewRates.subscribe = pollSubscribe(tradingViewRates);

/** vol.VIX, vol.VIX3M and vol.term (VIX3M/VIX) from two index levels. */
export function volData(vix: { value: number; asOf: string; source: string } | undefined, vix3m: { value: number; asOf: string; source: string } | undefined, cadenceSec: number, meta?: Record<string, unknown>): Datum[] {
  const out: Datum[] = [];
  if (vix) out.push({ key: DATUM_KEYS.vix, value: vix.value, source: vix.source, asOf: vix.asOf, cadenceSec, meta });
  if (vix3m) out.push({ key: DATUM_KEYS.vix3m, value: vix3m.value, source: vix3m.source, asOf: vix3m.asOf, cadenceSec, meta });
  if (vix && vix3m && vix.value > 0) out.push({ key: DATUM_KEYS.vixTerm, value: Math.round((vix3m.value / vix.value) * 1000) / 1000, source: vix.source, asOf: vix.asOf < vix3m.asOf ? vix.asOf : vix3m.asOf, cadenceSec, meta });
  return out;
}

export const tradingViewVol: Feed<ItemOf<'datum'>> = {
  name: 'tradingview.vol', kind: 'vol', live: true, requiresKey: null, cadenceSec: 60, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const rows = await scanDesk(['VIX', 'VIX3M'], ctx);
    const pick = (s: string): { value: number; asOf: string; source: string } | undefined => {
      const r = rows.find((x) => x.symbol === s)?.row;
      return r ? { value: r.close, asOf: r.asOf, source: tvSource(r) } : undefined;
    };
    const first = rows[0]?.row;
    return volData(pick('VIX'), pick('VIX3M'), 60, first ? tvMeta(first) : undefined).map((d) => item('datum', d, { source: d.source, asOf: d.asOf, cadenceSec: 60, symbol: d.key }));
  },
};

/* ───────────── economic calendar ───────────── */

export interface TvCalendarRow {
  id: string; title: string; country: string; indicator?: string; category?: string; period?: string; date: string;
  actual?: number | null; forecast?: number | null; previous?: number | null; importance: number; unit?: string; scale?: string; source?: string;
}

/** One TradingView calendar row (live or recorded) -> CalendarEvent. Values are in the row's unit and scale. */
export function mapTvCalendarRow(r: TvCalendarRow, asOf: string, source = 'tradingview:calendar'): CalendarEvent {
  const unit = `${r.unit ?? ''}${r.scale ?? ''}`;
  return {
    id: `tv_${r.id}`, code: titleToEventCode(r.title), name: r.period ? `${r.title} (${r.period})` : r.title, time: new Date(r.date).toISOString(),
    consensus: r.forecast ?? null, prior: r.previous ?? null, actual: r.actual ?? null,
    ...(unit ? { unit } : {}), importance: r.importance, source, asOf,
  };
}

export const tradingViewCalendar: Feed<ItemOf<'calendar'>> = {
  name: 'tradingview.calendar', kind: 'calendar', live: true, requiresKey: null, cadenceSec: 300, verified: true,
  enabled: () => true,
  async poll(ctx) {
    // Yesterday through six weeks out: covers revisions to fresh prints and the next FOMC meeting.
    const from = iso(ctx.now - DAY), to = iso(ctx.now + 42 * DAY);
    const res = await httpJson<{ status: string; result: TvCalendarRow[] }>(`${CALENDAR_URL}?from=${from}&to=${to}&countries=US`, { fetch: ctx.fetch, headers: { Origin: 'https://www.tradingview.com' } });
    const asOf = iso(ctx.now);
    return (res.result ?? []).map((r) => { const e = mapTvCalendarRow(r, asOf); return item('calendar', e, { source: e.source, asOf, cadenceSec: 300 }); });
  },
};

/* ───────────── chart export ───────────── */

/**
 * TradingView "Export chart data" CSV: header `time,open,high,low,close[,Volume,...]`, time as unix seconds or ISO.
 * Extra indicator columns are ignored. Rows that do not parse are dropped; output is ascending and de-duplicated.
 */
export function parseTradingViewCsv(csv: string, symbol: string, tf: Timeframe): Candle[] {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const header = (lines.shift() ?? '').split(',').map((h) => h.trim().toLowerCase());
  const col = (n: string): number => header.indexOf(n);
  const [ti, oi, hi, li, ci, vi] = [col('time'), col('open'), col('high'), col('low'), col('close'), col('volume')];
  if ([ti, oi, hi, li, ci].some((i) => i < 0)) throw new Error('TradingView CSV needs time,open,high,low,close columns');
  const byT = new Map<number, Candle>();
  for (const line of lines) {
    const c = line.split(',');
    const rawT = (c[ti] ?? '').trim();
    const sec = Number(rawT);
    const t = rawT !== '' && Number.isFinite(sec) ? sec * 1000 : Date.parse(rawT);
    const [o, h, l, cl] = [Number(c[oi]), Number(c[hi]), Number(c[li]), Number(c[ci])];
    if (![t, o, h, l, cl].every(Number.isFinite)) continue;
    const v = vi >= 0 ? Number(c[vi]) : 0;
    const open = tf === '1d' ? t : Math.floor(t / TF_MS[tf]) * TF_MS[tf];
    byT.set(open, { symbol, tf, t: open, o, h, l, c: cl, v: Number.isFinite(v) ? v : 0, source: 'tradingview:csv' });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
