/**
 * Earnings for the watchlist, all free:
 *  - TradingView scanner: next report date, EPS and revenue consensus for the next quarter, last report time.
 *  - Nasdaq earnings-surprise API: the last four report dates with EPS surprise.
 *  - Post-print history: close-to-close reaction around each past report, from daily candles.
 *  - Implied move: ATM straddle of the first expiry after the print (Yahoo chain), when the print is within 30 days.
 */
import { DAY, DEFAULT_WATCHLIST, INSTRUMENTS, dayKey, iso, minutesOfDay, type Candle, type EarningsInfo } from '@desk/contracts';
import { httpJson, mapLimit } from '../http';
import { item, type Feed, type FetchLike, type ItemOf } from '../types';
import { TV_SYMBOLS, tvScan } from './tradingview';
import { yahooCandles, yahooImpliedMove } from './yahoo';

type Timing = EarningsInfo['timing'];
type History = EarningsInfo['history'];

const EARN_COLUMNS = ['name', 'earnings_release_next_date', 'earnings_release_date', 'earnings_per_share_forecast_next_fq', 'revenue_forecast_next_fq'];
export interface TvEarningsRow { symbol: string; nextAt: number | null; lastAt: number | null; epsConsensus: number | null; revenueConsensus: number | null }

export function mapTvEarnings(res: { data: Array<{ s: string; d: Array<string | number | null> }> }): TvEarningsRow[] {
  const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return res.data.flatMap((r) => (typeof r.d[0] === 'string'
    ? [{ symbol: r.d[0], nextAt: n(r.d[1]) === null ? null : (n(r.d[1]) as number) * 1000, lastAt: n(r.d[2]) === null ? null : (n(r.d[2]) as number) * 1000, epsConsensus: n(r.d[3]), revenueConsensus: n(r.d[4]) }]
    : []));
}

/** Before the open / after the close from a release timestamp; a date-only stamp (midnight) is unknown. */
export function timingOf(tsMs: number | null): Timing {
  if (tsMs === null) return 'unknown';
  const m = minutesOfDay(tsMs);
  if (m === 0 || new Date(tsMs).getUTCHours() * 60 + new Date(tsMs).getUTCMinutes() === 0) return 'unknown';
  return m < 9 * 60 + 30 ? 'bmo' : m >= 16 * 60 ? 'amc' : 'unknown';
}

export interface NasdaqSurprise { data: { earningsSurpriseTable?: { rows?: Array<{ dateReported: string; percentageSurprise?: string | number }> } | null } | null }
export function mapNasdaqSurprise(res: NasdaqSurprise): Array<{ date: string; surprisePct: number | null }> {
  return (res.data?.earningsSurpriseTable?.rows ?? []).flatMap((r) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(r.dateReported.trim());
    if (!m) return [];
    const s = Number(r.percentageSurprise);
    return [{ date: `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`, surprisePct: Number.isFinite(s) ? s : null }];
  });
}

/**
 * Close-to-close reaction to each past print, newest first.
 * After-close (and unknown-time) reports: next session close vs report-day close. Before-open reports: report-day close vs prior close.
 * Dates without both sessions in `daily` are skipped, never estimated.
 */
export function postPrintHistory(reports: Array<{ date: string; surprisePct: number | null }>, timing: Timing, daily: Candle[]): History {
  const days = daily.map((c) => ({ day: dayKey(c.t), c: c.c }));
  const out: History = [];
  for (const r of reports) {
    const i = days.findIndex((d) => d.day === r.date);
    const [from, to] = timing === 'bmo' ? [days[i - 1], days[i]] : [days[i], days[i + 1]];
    if (i < 0 || !from || !to) continue;
    out.push({ date: r.date, surprisePct: r.surprisePct, nextDayPct: Math.round((to.c / from.c - 1) * 10_000) / 100 });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export async function fetchNasdaqSurprise(symbol: string, fetch?: FetchLike): Promise<NasdaqSurprise> {
  return httpJson<NasdaqSurprise>(`https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`, { fetch, headers: { Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } });
}

export const earningsFeed: Feed<ItemOf<'earnings'>> = {
  name: 'earnings', kind: 'earnings', live: false, requiresKey: null, cadenceSec: 21_600, verified: true,
  enabled: () => true,
  async poll(ctx) {
    const symbols = (ctx.symbols ?? DEFAULT_WATCHLIST).filter((s) => INSTRUMENTS[s]?.kind === 'stock' && INSTRUMENTS[s]?.tradable && TV_SYMBOLS[s]);
    if (symbols.length === 0) return [];
    const rows = mapTvEarnings(await tvScan(symbols.map((s) => TV_SYMBOLS[s] as string), EARN_COLUMNS, ctx.fetch));
    const asOf = iso(ctx.now);
    const infos = await mapLimit(rows.filter((r) => r.nextAt !== null), 3, async (r): Promise<EarningsInfo> => {
      const nextAt = r.nextAt as number;
      const timing = timingOf(nextAt) === 'unknown' ? timingOf(r.lastAt) : timingOf(nextAt);
      let history: History = [];
      const sources = ['tradingview'];
      try {
        const reports = mapNasdaqSurprise(await fetchNasdaqSurprise(r.symbol, ctx.fetch));
        const stored = (await ctx.loadCandles?.(r.symbol, '1d')) ?? [];
        const oldest = reports.reduce((a, x) => (x.date < a ? x.date : a), '9999');
        const daily = stored.length && dayKey(stored[0]!.t) < oldest ? stored : await yahooCandles(r.symbol, '1d', '2y', ctx.fetch);
        history = postPrintHistory(reports, timing, daily);
        sources.push('nasdaq', 'yahoo');
      } catch { /* history stays empty; the catalyst engine treats that as "no base rate" */ }
      let impliedMovePct: number | null = null;
      if (nextAt - ctx.now < 30 * DAY && nextAt > ctx.now - DAY) {
        try {
          const m = await yahooImpliedMove(r.symbol, ctx.now, ctx.fetch, nextAt);
          if (m) { impliedMovePct = Math.round(m.movePct * 100) / 100; sources.push('yahoo:options'); }
        } catch { /* null: the catalyst engine falls back to history */ }
      }
      return { symbol: r.symbol, date: iso(nextAt), timing, epsConsensus: r.epsConsensus, revenueConsensus: r.revenueConsensus, whisper: null, impliedMovePct, history, source: sources.join('+'), asOf };
    });
    return infos.flatMap((r) => (r.ok ? [item('earnings', r.value, { source: r.value.source, asOf, cadenceSec: 21_600, symbol: r.value.symbol })] : []));
  },
};
