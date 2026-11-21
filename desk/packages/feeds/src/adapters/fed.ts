/**
 * Fed pricing from 30-day Fed funds futures, CME FedWatch method:
 * a contract settles to 100 minus the month's average effective rate, so for a meeting on day d of an N-day month
 *   avg = (start * d + end * (N - d)) / N   =>   end = (avg * N - start * d) / (N - d)
 * where `start` is the rate going into the meeting, anchored on the nearest earlier month with no meeting.
 * P(25 bp move) = (end - start) / 0.25. Meeting dates come from the economic calendar, never from a hard-coded list.
 */
import { DATUM_KEYS, ET, iso, zoned, type CalendarEvent, type Datum } from '@desk/contracts';
import { item, type Feed, type FeedCtx, type ItemOf } from '../types';
import { fetchYahooChart, mapYahooQuote } from './yahoo';
import { fetchKalshiMarkets, kalshiFedProbs } from './predictions';
import { mapTvScan, tvScan } from './tradingview';

const MONTH_CODES = 'FGHJKMNQUVXZ';
export interface YearMonth { y: number; m: number }
export const ymKey = ({ y, m }: YearMonth): string => `${y}-${String(m).padStart(2, '0')}`;
const addMonths = ({ y, m }: YearMonth, k: number): YearMonth => { const i = y * 12 + (m - 1) + k; return { y: Math.floor(i / 12), m: (i % 12) + 1 }; };
const daysIn = ({ y, m }: YearMonth): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const zqTicker = (ym: YearMonth, venue: 'tradingview' | 'yahoo'): string =>
  venue === 'tradingview' ? `CBOT:ZQ${MONTH_CODES[ym.m - 1]}${ym.y}` : `ZQ${MONTH_CODES[ym.m - 1]}${String(ym.y).slice(2)}.CBT`;

/** FOMC decision times (epoch ms, ascending) from calendar rows coded FOMC. */
export function fomcMeetings(calendar: CalendarEvent[]): number[] {
  return [...new Set(calendar.filter((e) => e.code === 'FOMC').map((e) => Date.parse(e.time)))].sort((a, b) => a - b);
}

export interface FedWatch {
  meeting: string; start: number; end: number; changeBp: number;
  hike: number; cut: number; hold: number;
  /** Size of the move priced, in 25 bp steps (can exceed 1). */
  moves: number;
  anchor: 'prior_month' | 'chained' | 'next_month' | 'approx_prior_avg';
  contracts: Record<string, number>;
}

/**
 * @param meetings every known FOMC decision time (past ones in the chain months matter: they mark months that are not clean anchors)
 * @param prices   contract month 'YYYY-MM' -> futures price
 */
export function fedWatch(now: number, meetings: number[], prices: Record<string, number>): FedWatch {
  const next = meetings.find((t) => t > now);
  if (next === undefined) throw new Error('No upcoming FOMC meeting in the calendar');
  const z = zoned(next, ET);
  const M: YearMonth = { y: z.year, m: z.month };
  const meetingDay = (ym: YearMonth): number | null => {
    const t = meetings.find((x) => { const p = zoned(x, ET); return p.year === ym.y && p.month === ym.m; });
    return t === undefined ? null : zoned(t, ET).day;
  };
  const avg = (ym: YearMonth): number | null => { const p = prices[ymKey(ym)]; return typeof p === 'number' ? 100 - p : null; };
  /** Rate in force at the end of a month, chaining back through at most three meeting months. */
  const endOf = (ym: YearMonth, depth: number): { rate: number; chained: boolean } | null => {
    const a = avg(ym), d = meetingDay(ym);
    if (a === null) return null;
    if (d === null) return { rate: a, chained: false };
    if (depth === 0) return null;
    const prev = endOf(addMonths(ym, -1), depth - 1);
    const n = daysIn(ym);
    return prev && n > d ? { rate: (a * n - prev.rate * d) / (n - d), chained: true } : null;
  };

  const a = avg(M);
  if (a === null) throw new Error(`No Fed funds futures price for ${ymKey(M)}`);
  const n = daysIn(M), d = z.day;
  const prior = endOf(addMonths(M, -1), 3);
  const nextMonth = addMonths(M, 1), nextAvg = avg(nextMonth);
  let start: number, end: number, anchor: FedWatch['anchor'];
  if (prior && n > d) {
    start = prior.rate; end = (a * n - start * d) / (n - d); anchor = prior.chained ? 'chained' : 'prior_month';
  } else if (nextAvg !== null && meetingDay(nextMonth) === null && d > 0) {
    end = nextAvg; start = (a * n - end * (n - d)) / d; anchor = 'next_month';
  } else {
    const pa = avg(addMonths(M, -1));
    if (pa === null || n <= d) throw new Error(`No anchor contract around ${ymKey(M)}`);
    start = pa; end = (a * n - start * d) / (n - d); anchor = 'approx_prior_avg';
  }
  const moves = (end - start) / 0.25;
  const hike = Math.min(1, Math.max(0, moves)), cut = Math.min(1, Math.max(0, -moves));
  const r = (x: number, k = 4): number => Math.round(x * 10 ** k) / 10 ** k;
  return { meeting: iso(next), start: r(start), end: r(end), changeBp: r((end - start) * 100, 1), hike: r(hike), cut: r(cut), hold: r(1 - hike - cut), moves: r(moves, 3), anchor, contracts: { ...prices } };
}

/** The four fed.* data. Cross-check fields from Kalshi ride in `meta`. */
export function fedData(w: FedWatch, source: string, asOf: string, cadenceSec: number, kalshi: { hike: number; cut: number; hold: number; event: string } | null): Datum[] {
  const meta = {
    meeting: w.meeting, method: 'fedwatch', anchor: w.anchor, startRate: w.start, changeBp: w.changeBp, moves: w.moves, contracts: w.contracts,
    kalshi, kalshiGapHike: kalshi ? Math.round((w.hike - kalshi.hike) * 1000) / 1000 : null,
  };
  const d = (key: string, value: number): Datum => ({ key, value, source, asOf, cadenceSec, meta });
  return [d(DATUM_KEYS.fedHike, w.hike), d(DATUM_KEYS.fedCut, w.cut), d(DATUM_KEYS.fedHold, w.hold), d(DATUM_KEYS.fedImplied, w.end)];
}

async function zqPrices(months: YearMonth[], ctx: FeedCtx): Promise<{ prices: Record<string, number>; source: string; asOf: string }> {
  const prices: Record<string, number> = {};
  let asOf = '';
  try {
    const rows = mapTvScan(await tvScan(months.map((m) => zqTicker(m, 'tradingview')), ['close', 'change', 'change_abs', 'last_bar_update_time', 'update_mode', 'description'], ctx.fetch), ctx.now);
    for (const m of months) { const r = rows.find((x) => x.ticker === zqTicker(m, 'tradingview')); if (r) { prices[ymKey(m)] = r.close; if (r.asOf > asOf) asOf = r.asOf; } }
    if (Object.keys(prices).length >= 2) return { prices, source: 'tradingview:delayed10m', asOf };
  } catch { /* fall through to Yahoo */ }
  for (const m of months) {
    try {
      const q = mapYahooQuote(await fetchYahooChart(zqTicker(m, 'yahoo'), '1d', '5d', ctx.fetch), 'ZQ', 300);
      if (q) { prices[ymKey(m)] = q.price; if (q.asOf > asOf) asOf = q.asOf; }
    } catch { /* an expired or unlisted month is simply absent */ }
  }
  return { prices, source: 'yahoo:delayed', asOf: asOf || iso(ctx.now) };
}

export const fedWatchFeed: Feed<ItemOf<'datum'>> = {
  name: 'fedwatch', kind: 'fed', live: true, requiresKey: null, cadenceSec: 300, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const meetings = fomcMeetings(ctx.calendar ?? []);
    const next = meetings.find((t) => t > ctx.now);
    if (next === undefined) throw new Error('No upcoming FOMC meeting in the calendar; ingest the calendar first');
    const z = zoned(next, ET);
    const M: YearMonth = { y: z.year, m: z.month };
    const { prices, source, asOf } = await zqPrices([-3, -2, -1, 0, 1].map((k) => addMonths(M, k)), ctx);
    const w = fedWatch(ctx.now, meetings, prices);
    let kalshi: ReturnType<typeof kalshiFedProbs> = null;
    try { kalshi = kalshiFedProbs(await fetchKalshiMarkets('KXFEDDECISION', ctx.fetch), next); } catch { /* cross-check is optional */ }
    return fedData(w, `${source}:fedwatch`, asOf, 300, kalshi).map((d) => item('datum', d, { source: d.source, asOf: d.asOf, cadenceSec: 300, symbol: d.key, meta: { delayed: true, delayMin: 10 } }));
  },
};
