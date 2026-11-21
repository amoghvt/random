import { DEFAULT_WATCHLIST, dayKey, fromZoned, hashId, iso, zoned } from '@desk/contracts';
import type { CalendarEvent, EarningsInfo, EventCode } from '@desk/contracts';
import { KEYING } from './branches';
import { buildHistory } from './history';
import { impliedMove } from './implied';
import { indexWeight, tierDetail, TIER1_WEIGHT_PCT } from './tiering';
import type { BuildCtx, CatalystEx, HistoricalReactionEx } from './types';

/** Calendar code -> catalyst code for the pairs published together. */
const GROUP: Partial<Record<EventCode, EventCode>> = { CORE_CPI: 'CPI', CPI: 'CPI', CORE_PCE: 'PCE', PCE: 'PCE', CORE_PPI: 'PPI', PPI: 'PPI', NFP: 'NFP', UNEMPLOYMENT: 'NFP' };
const NAMES: Partial<Record<EventCode, string>> = { CPI: 'CPI (core MoM)', PCE: 'PCE (core MoM)', PPI: 'PPI (MoM)', NFP: 'Non-farm payrolls' };

/** One row per code and release time: the MoM series, then the provider's importance, then input order. */
function pick(events: CalendarEvent[]): CalendarEvent {
  return [...events].sort((a, b) => Number(/mom|m\/m/i.test(b.name)) - Number(/mom|m\/m/i.test(a.name)) || (b.importance ?? -1) - (a.importance ?? -1))[0]!;
}

/** Scheduled instant of an earnings print: a full timestamp is kept; a bare date becomes 07:00 ET (bmo) or 16:05 ET (amc, unknown). */
export function earningsTime(e: EarningsInfo): number {
  if (e.date.length > 10) return Date.parse(e.date);
  const [y, m, d] = e.date.split('-').map(Number) as [number, number, number];
  return e.timing === 'bmo' ? fromZoned(y, m, d, 7, 0) : fromZoned(y, m, d, 16, 5);
}

export function earningsHistoryRows(e: EarningsInfo): HistoricalReactionEx[] {
  return e.history.map((h) => ({ date: h.date, time: h.date, instrument: e.symbol, actual: null, consensus: null, surprise: h.surprisePct, m5Pct: null, m15Pct: null, h1Pct: null, closePct: h.nextDayPct, firstMoveReversed: null, resolution: '1d' as const }));
}

/**
 * One catalyst per release. CPI and core CPI published together are one catalyst keyed on core MoM with the headline as
 * the secondary metric (same for PCE; PPI is keyed on headline MoM with core secondary; payrolls carry the unemployment rate).
 * Ids are deterministic so a re-run upserts.
 */
export function buildCatalysts(events: CalendarEvent[], earnings: EarningsInfo[], ctx: BuildCtx): CatalystEx[] {
  const primary = ctx.primaryInstrument ?? 'NQ';
  const past = (ctx.pastEvents ?? []).filter((e) => Date.parse(e.time) < ctx.now);
  const out: CatalystEx[] = [];
  const groups = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    if (e.code === 'EARNINGS') continue;
    const k = `${GROUP[e.code] ?? e.code}|${e.time}|${GROUP[e.code] ? '' : e.name}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  for (const [k, evs] of groups) {
    const code = k.split('|')[0] as EventCode;
    const keying = KEYING[code];
    const prim = keying ? evs.filter((e) => e.code === keying.primary) : evs;
    const sec = keying?.secondary ? evs.filter((e) => e.code === keying.secondary) : [];
    const main = pick(prim.length > 0 ? prim : evs);
    const second = prim.length > 0 && sec.length > 0 ? pick(sec) : null;
    const t = Date.parse(main.time);
    const tier = tierDetail(main, ctx);
    const base: CatalystEx = {
      id: hashId('cat', code, main.time, GROUP[main.code] ? '' : main.name),
      code, name: prim.length > 0 && keying ? NAMES[code] ?? main.name : main.name, tier: tier.tier, tierReason: tier.reason,
      scheduledAt: main.time, instruments: [primary, 'ES', 'US10Y'].filter((s, i, a) => a.indexOf(s) === i),
      consensus: main.consensus, prior: main.revisedPrior ?? main.prior, whisper: null,
      ...(main.unit ? { unit: main.unit } : {}),
      impliedMovePct: null, impliedMoveSource: null,
      history: ctx.candlesByTf && tier.tier < 3 ? buildHistory(main.code, past, ctx.candlesByTf, 8, Math.min(ctx.now, t)) : [],
      predictionOdds: (ctx.predictionMarkets ?? []).filter((m) => (m.eventCode === code || m.eventCode === main.code) && (m.eventDate === undefined || m.eventDate.slice(0, 10) === dayKey(t))),
      matrix: null,
      status: main.actual !== null ? 'resolved' : ctx.now >= t ? 'live' : 'upcoming',
      resolution: main.actual !== null ? { actual: main.actual, branchId: null, resolvedAt: main.asOf } : null,
      keyedOn: main.code, eventIds: evs.map((e) => e.id),
      ...(second ? { secondary: { code: second.code, name: second.name, consensus: second.consensus, prior: second.revisedPrior ?? second.prior, actual: second.actual, ...(second.unit ? { unit: second.unit } : {}) } } : {}),
      source: main.source, asOf: main.asOf,
    };
    const im = impliedMove(base, ctx);
    out.push({ ...base, impliedMovePct: im.pct, impliedMoveSource: im.source });
  }

  const calendarEarnings = events.filter((e) => e.code === 'EARNINGS');
  const seen = new Set<string>();
  const infos = [...earnings, ...calendarEarnings.filter((e) => e.symbol && !earnings.some((x) => x.symbol === e.symbol && dayKey(earningsTime(x)) === dayKey(e.time)))
    .map((e): EarningsInfo => ({ symbol: e.symbol as string, date: e.time, timing: 'unknown', epsConsensus: e.consensus, revenueConsensus: null, whisper: null, impliedMovePct: null, history: [], source: e.source, asOf: e.asOf }))];
  for (const e of infos) {
    const t = earningsTime(e);
    const key = `${e.symbol}|${dayKey(t)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tier = tierDetail({ code: 'EARNINGS', name: `${e.symbol} earnings`, symbol: e.symbol }, { ...ctx, watchlist: ctx.watchlist ?? DEFAULT_WATCHLIST });
    const w = indexWeight(e.symbol, ctx);
    const base: CatalystEx = {
      id: hashId('cat', 'EARNINGS', e.symbol, dayKey(t)),
      code: 'EARNINGS', name: `${e.symbol} earnings`, tier: tier.tier, tierReason: tier.reason,
      scheduledAt: iso(t), instruments: w.pct !== null && w.pct > TIER1_WEIGHT_PCT ? [e.symbol, primary] : [e.symbol],
      consensus: e.epsConsensus, prior: null, whisper: e.whisper, unit: 'EPS', symbol: e.symbol,
      impliedMovePct: e.impliedMovePct, impliedMoveSource: e.impliedMovePct !== null ? 'options' : null,
      history: earningsHistoryRows(e).slice(0, 8), predictionOdds: [], matrix: null,
      status: ctx.now >= t ? 'live' : 'upcoming', resolution: null,
      keyedOn: 'EARNINGS', earnings: e, source: e.source, asOf: e.asOf,
    };
    const im = impliedMove(base, ctx);
    out.push({ ...base, impliedMovePct: im.pct, impliedMoveSource: im.source });
  }
  return out.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt) || a.id.localeCompare(b.id));
}

/** Weekday of the release in ET, 0 = Sunday. */
export const releaseWeekday = (c: Pick<CatalystEx, 'scheduledAt'>): number => zoned(c.scheduledAt).weekday;
