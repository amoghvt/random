/**
 * Prediction markets: Kalshi public API and Polymarket gamma API (both free, no key).
 * Kalshi series tickers are discovered from /series by title, not guessed; the defaults below are
 * the tickers that discovery returned on 2026-11-21 and are only used if discovery fails.
 */
import { DAY, iso, type EventCode, type PredictionMarket } from '@desk/contracts';
import { httpJson, mapLimit, settle } from '../http';
import { item, type Feed, type FetchLike, type ItemOf } from '../types';

type Outcome = PredictionMarket['outcomes'][number];
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/* ───────────── Kalshi ───────────── */

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiSeries { ticker: string; title: string; category?: string; frequency?: string }
export interface KalshiMarket {
  ticker: string; event_ticker: string; title: string; subtitle?: string; yes_sub_title?: string;
  yes_bid_dollars?: string | null; yes_ask_dollars?: string | null; last_price_dollars?: string | null; volume_fp?: string | null;
  floor_strike?: number | null; cap_strike?: number | null; strike_type?: string; close_time: string; status?: string;
}

/** Exact (lower-cased) US series titles -> event code. Country-specific series have other titles and never match. */
const KALSHI_TITLES: Record<string, EventCode> = {
  'fed meeting': 'FOMC', 'fed funds rate': 'FOMC', cpi: 'CPI', inflation: 'CPI', 'cpi core': 'CORE_CPI', 'core inflation': 'CORE_CPI',
  'jobs numbers': 'NFP', unemployment: 'UNEMPLOYMENT', 'us core pce inflation': 'CORE_PCE', 'us gdp growth': 'GDP',
};
export const KALSHI_DEFAULT_SERIES: Record<string, EventCode> = {
  KXFEDDECISION: 'FOMC', KXFED: 'FOMC', KXCPI: 'CPI', KXCPIYOY: 'CPI', KXCPICORE: 'CORE_CPI', KXCPICOREYOY: 'CORE_CPI',
  KXPAYROLLS: 'NFP', KXU3: 'UNEMPLOYMENT', KXPCECORE: 'CORE_PCE', KXGDP: 'GDP',
};

/** Pick the current-generation ("KX") series whose titles name a US release the catalyst engine branches on. */
export function selectKalshiSeries(series: KalshiSeries[]): Record<string, EventCode> {
  const out: Record<string, EventCode> = {};
  for (const s of series) {
    const code = KALSHI_TITLES[s.title.trim().toLowerCase()];
    if (code && s.ticker.startsWith('KX')) out[s.ticker] = code;
  }
  return out;
}

let seriesCache: { at: number; map: Record<string, EventCode>; titles: Record<string, string> } | null = null;
export async function discoverKalshiSeries(now: number, fetch?: FetchLike): Promise<{ map: Record<string, EventCode>; titles: Record<string, string>; discovered: boolean }> {
  if (seriesCache && now - seriesCache.at < DAY && now >= seriesCache.at) return { ...seriesCache, discovered: true };
  try {
    const res = await httpJson<{ series: KalshiSeries[] }>(`${KALSHI}/series?category=Economics`, { fetch, timeoutMs: 30_000 });
    const map = selectKalshiSeries(res.series ?? []);
    if (Object.keys(map).length === 0) throw new Error('no matching series');
    seriesCache = { at: now, map, titles: Object.fromEntries(res.series.filter((s) => map[s.ticker]).map((s) => [s.ticker, s.title])) };
    return { ...seriesCache, discovered: true };
  } catch {
    return { map: KALSHI_DEFAULT_SERIES, titles: {}, discovered: false };
  }
}

const num = (s: string | null | undefined): number | null => { const n = s == null ? NaN : Number(s); return Number.isFinite(n) ? n : null; };
/** Yes probability: bid/ask mid when there is a two-sided market, else last trade. */
export function kalshiYesProb(m: KalshiMarket): number | null {
  const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
  if (bid !== null && ask !== null && ask > 0 && ask >= bid && ask - bid <= 0.2) return (bid + ask) / 2;
  if (last !== null && last > 0) return last;
  return bid !== null && ask !== null && ask > 0 ? (bid + ask) / 2 : null;
}

const fmtStrike = (x: number): string => (Math.abs(x) >= 1000 ? `${Math.round(x / 1000)}k` : String(x));
/**
 * A ladder of "above X" markets -> disjoint buckets. Bucket (lo, hi]: lo exclusive, hi inclusive, so the
 * (0.2, 0.3] bucket of a CPI ladder is "prints 0.3". Probabilities are differenced, floored at 0 and renormalised.
 */
export function ladderToBuckets(steps: Array<{ strike: number; pAbove: number }>): Outcome[] {
  const s = [...steps].sort((a, b) => a.strike - b.strike);
  if (s.length === 0) return [];
  const raw: Outcome[] = [{ label: `<= ${fmtStrike(s[0]!.strike)}`, prob: 1 - s[0]!.pAbove, lo: null, hi: s[0]!.strike }];
  for (let i = 1; i < s.length; i++) raw.push({ label: `${fmtStrike(s[i - 1]!.strike)} to ${fmtStrike(s[i]!.strike)}`, prob: s[i - 1]!.pAbove - s[i]!.pAbove, lo: s[i - 1]!.strike, hi: s[i]!.strike });
  raw.push({ label: `> ${fmtStrike(s[s.length - 1]!.strike)}`, prob: s[s.length - 1]!.pAbove, lo: s[s.length - 1]!.strike, hi: null });
  const floored = raw.map((o) => ({ ...o, prob: Math.max(0, o.prob) }));
  const total = floored.reduce((a, o) => a + o.prob, 0);
  return floored.map((o) => ({ ...o, prob: r4(total > 0 ? o.prob / total : 0) }));
}

/** Markets of one series -> one PredictionMarket per event (meeting / release month). */
export function mapKalshiMarkets(markets: KalshiMarket[], series: string, code: EventCode, asOf: string, seriesTitle?: string): PredictionMarket[] {
  const byEvent = new Map<string, KalshiMarket[]>();
  for (const m of markets) byEvent.set(m.event_ticker, [...(byEvent.get(m.event_ticker) ?? []), m]);
  const out: PredictionMarket[] = [];
  for (const [event, ms] of byEvent) {
    const priced = ms.flatMap((m) => { const p = kalshiYesProb(m); return p === null ? [] : [{ m, p }]; });
    if (priced.length === 0) continue;
    const ladder = priced.every(({ m }) => m.strike_type === 'greater' && typeof m.floor_strike === 'number');
    const outcomes: Outcome[] = ladder
      ? ladderToBuckets(priced.map(({ m, p }) => ({ strike: m.floor_strike as number, pAbove: p })))
      : priced.map(({ m, p }) => ({ label: m.yes_sub_title || m.subtitle || m.title, prob: r4(clamp01(p)), ...parseBucket(m.yes_sub_title || m.subtitle || '') }));
    const volume = ms.reduce((a, m) => a + (num(m.volume_fp) ?? 0), 0);
    out.push({
      id: `kalshi_${event}`, venue: 'kalshi', title: `${seriesTitle ?? series}: ${event.slice(series.length + 1) || event}`, eventCode: code,
      eventDate: ms[0]!.close_time.slice(0, 10), outcomes, volume: Math.round(volume), asOf, url: `https://kalshi.com/markets/${series.toLowerCase()}`,
    });
  }
  return out.sort((a, b) => (a.eventDate ?? '').localeCompare(b.eventDate ?? ''));
}

export async function fetchKalshiMarkets(series: string, fetch?: FetchLike): Promise<KalshiMarket[]> {
  return (await httpJson<{ markets: KalshiMarket[] }>(`${KALSHI}/markets?series_ticker=${series}&status=open&limit=200`, { fetch })).markets ?? [];
}

/** Hike / cut / hold from the KXFEDDECISION event closing nearest the meeting date; null when none is listed. */
export function kalshiFedProbs(markets: KalshiMarket[], meetingMs: number): { hike: number; cut: number; hold: number; event: string } | null {
  const near = markets.filter((m) => Math.abs(Date.parse(m.close_time) - meetingMs) < 3 * DAY);
  if (near.length === 0) return null;
  const event = near[0]!.event_ticker;
  let hike = 0, cut = 0, hold = 0;
  for (const m of near.filter((x) => x.event_ticker === event)) {
    const p = kalshiYesProb(m) ?? 0, label = `${m.yes_sub_title ?? ''} ${m.subtitle ?? ''}`.toLowerCase();
    if (/maintain|hike 0|no change/.test(label)) hold += p; else if (label.includes('cut')) cut += p; else if (label.includes('hike')) hike += p;
  }
  const total = hike + cut + hold;
  return total > 0 ? { hike: r4(hike / total), cut: r4(cut / total), hold: r4(hold / total), event } : null;
}

export const kalshi: Feed<ItemOf<'prediction'>> = {
  name: 'kalshi', kind: 'predictions', live: true, requiresKey: null, cadenceSec: 120, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const { map, titles } = await discoverKalshiSeries(ctx.now, ctx.fetch);
    const asOf = iso(ctx.now);
    const results = await mapLimit(Object.entries(map), 4, async ([series, code]) =>
      // The two nearest events per series: this release and the next.
      mapKalshiMarkets(await fetchKalshiMarkets(series, ctx.fetch), series, code, asOf, titles[series]).filter((p) => (p.eventDate ?? '') >= asOf.slice(0, 10)).slice(0, 2));
    return settle(results).flat().map((p) => item('prediction', p, { source: 'kalshi', asOf, cadenceSec: 120 }));
  },
};

/* ───────────── Polymarket ───────────── */

const GAMMA = 'https://gamma-api.polymarket.com';
export interface PolyMarket { id: string; question: string; groupItemTitle?: string; outcomes?: string; outcomePrices?: string; volumeNum?: number; closed?: boolean; active?: boolean; endDate?: string }
export interface PolyEvent { id: string; slug: string; title: string; endDate?: string; volume?: number; closed?: boolean; markets?: PolyMarket[] }

const NON_US = /\b(ecb|boe|boj|bank of (england|japan|canada)|euro|uk|japan|china|canada|turkey|argentina|brazil|russia|india|mexico|germany|france)\b/i;
/** Event title -> code; null for anything the catalyst engine cannot branch on. */
export function polymarketEventCode(title: string): EventCode | null {
  if (NON_US.test(title)) return null;
  const t = title.toLowerCase();
  if (/\bfed\b.*\b(decision|rate|rates|cut|cuts|hike|hikes)\b|\bfomc\b/.test(t) && !/powell|chair|board|nominee|fired?\b/.test(t)) return 'FOMC';
  if (/core (cpi|inflation)/.test(t)) return 'CORE_CPI';
  if (/\bcpi\b|\binflation\b/.test(t)) return 'CPI';
  if (/payrolls?|jobs report|jobs added/.test(t)) return 'NFP';
  if (/unemployment rate/.test(t)) return 'UNEMPLOYMENT';
  if (/\bpce\b/.test(t)) return 'CORE_PCE';
  if (/\bgdp\b/.test(t)) return 'GDP';
  return null;
}

/**
 * Bucket bounds from an outcome label where the label states them: "25 bps increase" -> 25..25,
 * "50+ bps decrease" -> hi -50, "No change" -> 0..0, "0.3% to 0.4%" -> 0.3..0.4, "Above 4.5%" -> lo 4.5.
 */
export function parseBucket(label: string): { lo?: number | null; hi?: number | null } {
  const t = label.toLowerCase().replace(/,/g, '').replace(/[−–—]/g, '-');
  if (/^no change$|maintains? rate/.test(t)) return { lo: 0, hi: 0 };
  const n = (s: string): number => Number(s) * (/k\b/.test(t.slice(t.indexOf(s) + s.length, t.indexOf(s) + s.length + 1)) ? 1000 : 1);
  const sign = /decrease|cut|lower\b/.test(t) && /bps?/.test(t) ? -1 : 1;
  const range = /(-?\d+(?:\.\d+)?)\s*k?%?\s*(?:to|-)\s*(-?\d+(?:\.\d+)?)/.exec(t);
  if (range) return { lo: n(range[1]!), hi: n(range[2]!) };
  const one = /(-?\d+(?:\.\d+)?)/.exec(t);
  if (!one) return {};
  const x = n(one[1]!) * sign;
  const open = /\d\+|or more|or higher|at least|above|over|greater|>|≥/.test(t), closed = /or less|or lower|or fewer|below|under|<|≤/.test(t);
  if (open) return sign < 0 ? { lo: null, hi: x } : { lo: x, hi: null };
  if (closed) return { lo: null, hi: x };
  return { lo: x, hi: x };
}

const jsonArr = (s: string | undefined): string[] => { try { const v: unknown = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

export function mapPolymarketEvent(e: PolyEvent, asOf: string): PredictionMarket | null {
  const code = polymarketEventCode(e.title);
  const open = (e.markets ?? []).filter((m) => !m.closed);
  if (!code || open.length === 0) return null;
  let outcomes: Outcome[];
  if (open.length === 1) {
    const labels = jsonArr(open[0]!.outcomes), prices = jsonArr(open[0]!.outcomePrices).map(Number);
    outcomes = labels.flatMap((label, i) => (Number.isFinite(prices[i]) ? [{ label, prob: r4(clamp01(prices[i] as number)) }] : []));
  } else {
    outcomes = open.flatMap((m) => {
      const yes = Number(jsonArr(m.outcomePrices)[0]);
      const label = m.groupItemTitle || m.question;
      return Number.isFinite(yes) ? [{ label, prob: r4(clamp01(yes)), ...parseBucket(label) }] : [];
    });
  }
  if (outcomes.length === 0) return null;
  return {
    id: `polymarket_${e.id}`, venue: 'polymarket', title: e.title, eventCode: code, ...(e.endDate ? { eventDate: e.endDate.slice(0, 10) } : {}),
    outcomes, ...(typeof e.volume === 'number' ? { volume: Math.round(e.volume) } : {}), asOf, url: `https://polymarket.com/event/${e.slug}`,
  };
}

const POLY_TAGS = ['fed', 'inflation', 'economy'];
export const polymarket: Feed<ItemOf<'prediction'>> = {
  name: 'polymarket', kind: 'predictions', live: true, requiresKey: null, cadenceSec: 120, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const asOf = iso(ctx.now);
    const pages = settle(await mapLimit(POLY_TAGS, 3, (tag) => httpJson<PolyEvent[]>(`${GAMMA}/events?closed=false&tag_slug=${tag}&limit=100&order=volume&ascending=false`, { fetch: ctx.fetch, timeoutMs: 30_000 })));
    const seen = new Map<string, PredictionMarket>();
    for (const e of pages.flat()) { const p = mapPolymarketEvent(e, asOf); if (p) seen.set(p.id, p); }
    return [...seen.values()].map((p) => item('prediction', p, { source: 'polymarket', asOf, cadenceSec: 120 }));
  },
};
