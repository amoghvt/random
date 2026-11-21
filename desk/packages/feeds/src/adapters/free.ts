/**
 * Smaller free adapters: FinancialJuice RSS (headlines), ForexFactory weekly JSON (calendar fallback),
 * Coinbase Exchange (crypto), CFTC Commitments of Traders (NQ positioning).
 */
import { XMLParser } from 'fast-xml-parser';
import { DATUM_KEYS, TF_MS, hashId, iso, type CalendarEvent, type Candle, type Datum, type LaggedFact, type Quote } from '@desk/contracts';
import { titleToEventCode } from '../calendar-codes';
import { lagText } from '../freshness';
import { classifyHeadlines, cleanTitle, dedupeHeadlines, type RawHeadline } from '../headlines';
import { llmFromEnv } from '../llm';
import { httpJson, httpText, mapLimit, settle } from '../http';
import { item, pollSubscribe, type Feed, type ItemOf } from '../types';

/* ───────────── FinancialJuice ───────────── */

const FJ_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const xml = new XMLParser({ ignoreAttributes: true, processEntities: true });

export function parseRss(body: string, source: string): RawHeadline[] {
  const doc = xml.parse(body) as { rss?: { channel?: { item?: unknown } } };
  const raw = doc.rss?.channel?.item;
  const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<{ title?: unknown; link?: unknown; pubDate?: unknown }>;
  const out: RawHeadline[] = [];
  for (const it of items) {
    const t = Date.parse(String(it.pubDate ?? ''));
    const title = cleanTitle(String(it.title ?? ''));
    if (!title || Number.isNaN(t)) continue;
    out.push({ title, ts: iso(t), source, ...(typeof it.link === 'string' ? { url: it.link } : {}) });
  }
  return out;
}

export const financialJuice: Feed<ItemOf<'headline'>> = {
  name: 'financialjuice', kind: 'headlines', live: true, requiresKey: null, cadenceSec: 60, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const raws = dedupeHeadlines(parseRss(await httpText(FJ_URL, { fetch: ctx.fetch, headers: { Accept: 'application/rss+xml, application/xml, text/xml' } }), 'financialjuice'));
    const classified = await classifyHeadlines(raws, llmFromEnv(ctx.env));
    return classified.map((h) => item('headline', h, { source: h.source, asOf: h.ts, cadenceSec: 60 }));
  },
};
financialJuice.subscribe = pollSubscribe(financialJuice);

/* ───────────── ForexFactory ───────────── */

export interface FfRow { title: string; country: string; date: string; impact: string; forecast: string; previous: string }
const FF_IMPORTANCE: Record<string, number> = { High: 1, Medium: 0, Low: -1, Holiday: -1 };
const ffNum = (s: string): { value: number | null; unit: string } => {
  const m = /^(-?\d+(?:\.\d+)?)\s*([%KMBT]?)$/i.exec(s.trim().replace(/,/g, ''));
  return m ? { value: Number(m[1]), unit: m[2] ?? '' } : { value: null, unit: '' };
};

/** ForexFactory rows carry forecast and previous but no actual. USD rows only. */
export function mapForexFactory(rows: FfRow[], asOf: string): CalendarEvent[] {
  return rows.filter((r) => r.country === 'USD').map((r) => {
    const f = ffNum(r.forecast), p = ffNum(r.previous);
    const unit = f.unit || p.unit;
    return {
      id: hashId('ff', r.title, r.date), code: titleToEventCode(r.title), name: r.title, time: new Date(r.date).toISOString(),
      consensus: f.value, prior: p.value, actual: null, ...(unit ? { unit } : {}), importance: FF_IMPORTANCE[r.impact] ?? 0, source: 'forexfactory', asOf,
    };
  });
}

export const forexFactory: Feed<ItemOf<'calendar'>> = {
  name: 'forexfactory', kind: 'calendar', live: false, requiresKey: null, cadenceSec: 3600, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const asOf = iso(ctx.now);
    return mapForexFactory(await httpJson<FfRow[]>('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { fetch: ctx.fetch }), asOf)
      .map((e) => item('calendar', e, { source: e.source, asOf, cadenceSec: 3600 }));
  },
};

/* ───────────── Coinbase ───────────── */

const CB = 'https://api.exchange.coinbase.com';
const CB_PRODUCTS: Record<string, string> = { BTC: 'BTC-USD', ETH: 'ETH-USD' };
export interface CoinbaseTicker { price: string; time: string; bid?: string; ask?: string; volume?: string }

export function mapCoinbaseTicker(t: CoinbaseTicker, symbol: string): Quote {
  return { symbol, price: Number(t.price), prevClose: null, changePct: null, asOf: new Date(t.time).toISOString(), source: 'coinbase', cadenceSec: 60 };
}
/** Coinbase candle rows are [time_sec, low, high, open, close, volume], newest first. */
export function mapCoinbaseCandles(rows: number[][], symbol: string): Candle[] {
  return rows.filter((r) => r.length >= 6 && r.every(Number.isFinite))
    .map((r): Candle => ({ symbol, tf: '1m', t: (r[0] as number) * 1000, l: r[1] as number, h: r[2] as number, o: r[3] as number, c: r[4] as number, v: r[5] as number, source: 'coinbase' }))
    .sort((a, b) => a.t - b.t);
}

export const coinbase: Feed<ItemOf<'quote'> | ItemOf<'candle'>> = {
  name: 'coinbase', kind: 'crypto', live: true, requiresKey: null, cadenceSec: 60, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const symbols = (ctx.symbols ?? Object.keys(CB_PRODUCTS)).filter((s) => CB_PRODUCTS[s]);
    const per = await mapLimit(symbols, 2, async (s): Promise<Array<ItemOf<'quote'> | ItemOf<'candle'>>> => {
      const p = CB_PRODUCTS[s] as string;
      const q = mapCoinbaseTicker(await httpJson<CoinbaseTicker>(`${CB}/products/${p}/ticker`, { fetch: ctx.fetch }), s);
      const candles = mapCoinbaseCandles(await httpJson<number[][]>(`${CB}/products/${p}/candles?granularity=60`, { fetch: ctx.fetch }), s).slice(-120);
      return [item('quote', q, { source: 'coinbase', asOf: q.asOf, cadenceSec: 60, symbol: s }), ...candles.map((c) => item('candle', c, { source: 'coinbase', asOf: iso(c.t + TF_MS['1m']), cadenceSec: 60, symbol: s }))];
    });
    return settle(per).flat();
  },
};
coinbase.subscribe = pollSubscribe(coinbase);

/* ───────────── CFTC Commitments of Traders ───────────── */

/** Traders in Financial Futures, futures only (Socrata dataset gpe5-46if). 209742 = E-mini Nasdaq-100. */
const CFTC_URL = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json';
const NQ_CODE = '209742';
export interface CftcRow {
  report_date_as_yyyy_mm_dd: string; contract_market_name: string; cftc_contract_market_code: string; open_interest_all?: string;
  lev_money_positions_long?: string; lev_money_positions_short?: string; asset_mgr_positions_long?: string; asset_mgr_positions_short?: string;
}

/**
 * pos.cftc.NQ = leveraged-funds net contracts (the speculative leg of the TFF report), plus a LaggedFact:
 * positions are as of the Tuesday report date and published Friday.
 */
export function mapCftc(rows: CftcRow[], now: number): { datum: Datum; fact: LaggedFact } | null {
  const r = rows.filter((x) => x.cftc_contract_market_code.trim() === NQ_CODE).sort((a, b) => b.report_date_as_yyyy_mm_dd.localeCompare(a.report_date_as_yyyy_mm_dd))[0];
  if (!r) return null;
  const n = (s: string | undefined): number => Number(s ?? 0);
  const lev = n(r.lev_money_positions_long) - n(r.lev_money_positions_short);
  const am = n(r.asset_mgr_positions_long) - n(r.asset_mgr_positions_short);
  const periodEnd = r.report_date_as_yyyy_mm_dd.slice(0, 10);
  const published = iso(Date.parse(`${periodEnd}T20:30:00Z`) + 3 * 86_400_000);
  const signed = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x).toLocaleString('en-US')}`;
  return {
    datum: { key: DATUM_KEYS.cftc('NQ'), value: lev, source: 'cftc:tff', asOf: `${periodEnd}T00:00:00.000Z`, cadenceSec: 7 * 86_400, meta: { periodEnd, assetMgrNet: am, openInterest: n(r.open_interest_all), group: 'leveraged_funds', market: r.contract_market_name } },
    fact: {
      id: hashId('cftc', NQ_CODE, periodEnd), kind: 'cftc_cot',
      text: `NQ leveraged funds net ${signed(lev)} contracts, asset managers ${signed(am)}; ${lagText(periodEnd, now)}`,
      periodEnd, publishedAt: published, source: 'cftc:tff',
    },
  };
}

export const cftc: Feed<ItemOf<'datum'> | ItemOf<'lagged'>> = {
  name: 'cftc.cot', kind: 'positioning', live: false, requiresKey: null, cadenceSec: 21_600, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const where = encodeURIComponent(`cftc_contract_market_code='${NQ_CODE}'`);
    const rows = await httpJson<CftcRow[]>(`${CFTC_URL}?$limit=4&$order=${encodeURIComponent('report_date_as_yyyy_mm_dd DESC')}&$where=${where}`, { fetch: ctx.fetch, timeoutMs: 30_000 });
    const m = mapCftc(rows, ctx.now);
    if (!m) throw new Error('CFTC: no E-mini Nasdaq-100 row');
    const base = { source: 'cftc:tff', asOf: m.datum.asOf, cadenceSec: 7 * 86_400 };
    return [item('datum', m.datum, { ...base, symbol: m.datum.key }), item('lagged', m.fact, base)];
  },
};
