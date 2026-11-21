import { DAY, INSTRUMENTS, MIN, dayKey, hashId, hhmm, iso, median, round } from '@desk/contracts';
import type { Candle, Headline, ScenarioBranch, ScenarioMatrix, TradePlan } from '@desk/contracts';
import { cashCloseAfter } from './history';
import { vixDailyP90 } from './implied';
import { buildTrade, fitAccount, fmtPrice, roundToOne } from './matrix';
import type { AdhocCtx, AnalogEvent, AnalogStats, CatalystEx } from './types';

export const ANALOG_DRAWDOWN_SESSIONS = 20;
export const ANALOG_RECOVERY_CAP_SESSIONS = 60;
export const NO_ANALOG = 'no analog sample on file';

const KINDS: Array<{ kind: string; label: string; re: RegExp }> = [
  { kind: 'founder_departure', label: 'forced founder or CEO departure', re: /\b(ceo|founder|chief executive)\b.*\b(resign|steps? down|ousted|fired|departs?|removed)|\b(resign|steps? down|ousted|fired)\b.*\b(ceo|founder|chief executive)\b/i },
  { kind: 'export_control', label: 'export-control action', re: /\bexport (control|curb|ban|restriction)|\bentity list\b|\bchip (ban|curbs?)\b/i },
  { kind: 'central_bank_surprise', label: 'central-bank surprise', re: /\b(emergency|unscheduled|surprise|inter-?meeting)\b.*\b(cut|hike|rate|meeting)\b/i },
  { kind: 'geopolitical_strike', label: 'geopolitical strike', re: /\b(strike|missile|attack|invasion|invades?|blockade)\b/i },
  { kind: 'tariff_action', label: 'tariff action', re: /\btariffs?\b/i },
];
export function adhocKind(title: string): { kind: string; label: string } {
  const k = KINDS.find((x) => x.re.test(title));
  return k ? { kind: k.kind, label: k.label } : { kind: 'other', label: 'unclassified shock' };
}

/**
 * Median drawdown and recovery window for dated real events of one kind, from recorded daily candles.
 * base = last daily close before the event date. drawdown = lowest low over the event day and the next 20 sessions vs base.
 * recovery = sessions from the event day to the first close at or above base, capped at 60; unrecovered events are counted, not averaged.
 * Events the candles do not cover are dropped. With no usable event the text says so and every number is null.
 */
export function analogStats(kind: string, candles: Candle[], events: AnalogEvent[] = []): AnalogStats {
  const rows: AnalogStats['events'] = [];
  for (const e of events.filter((x) => x.kind === kind)) {
    const i = candles.findIndex((c) => dayKey(c.t + DAY / 2) >= e.date.slice(0, 10));
    if (i < 1 || dayKey(candles[i]!.t + DAY / 2) > dayKey(Date.parse(e.date.slice(0, 10)) + 5 * DAY)) continue;
    const base = candles[i - 1]!.c;
    const window = candles.slice(i, i + ANALOG_DRAWDOWN_SESSIONS + 1);
    const drawdownPct = round(Math.min(0, (Math.min(...window.map((c) => c.l)) / base - 1) * 100), 2);
    const rec = candles.slice(i, i + ANALOG_RECOVERY_CAP_SESSIONS).findIndex((c) => c.c >= base);
    rows.push({ date: e.date.slice(0, 10), label: e.label, drawdownPct, recoverySessions: rec < 0 ? null : rec });
  }
  if (rows.length === 0) return { kind, n: 0, medianDrawdownPct: null, medianRecoverySessions: null, recovered: 0, windowSessions: ANALOG_DRAWDOWN_SESSIONS, events: [], text: NO_ANALOG };
  const recs = rows.map((r) => r.recoverySessions).filter((x): x is number => x !== null);
  const dd = round(median(rows.map((r) => r.drawdownPct)), 2);
  const rec = recs.length > 0 ? round(median(recs), 0) : null;
  const sym = candles[0]?.symbol ?? '';
  return {
    kind, n: rows.length, medianDrawdownPct: dd, medianRecoverySessions: rec, recovered: recs.length, windowSessions: ANALOG_DRAWDOWN_SESSIONS, events: rows,
    text: `${rows.length} analog${rows.length === 1 ? '' : 's'} on ${sym}: median drawdown ${dd}% inside ${ANALOG_DRAWDOWN_SESSIONS} sessions, ${recs.length} of ${rows.length} back to the prior close${rec !== null ? `, median ${rec} sessions` : ''}.`,
  };
}

/** Ad-hoc catalyst for an impact-3 headline: a two-branch matrix (resolves / escalates) and the nearest analog, or null below impact 3. */
export function adhocCatalyst(headline: Headline, ctx: AdhocCtx): CatalystEx | null {
  if (headline.impact < 3) return null;
  const { kind, label } = adhocKind(headline.title);
  const tagged = headline.symbols.find((s) => INSTRUMENTS[s]?.tradable);
  const instrument = ctx.instrument ?? tagged ?? 'NQ';
  const stats = analogStats(kind, ctx.analogCandles ?? [], ctx.analogEvents ?? []);
  const analog = stats.n > 0 ? `Nearest analog, ${label}: ${stats.text}` : `Nearest analog, ${label}: ${NO_ANALOG}.`;
  const ts = Date.parse(headline.ts);
  const id = hashId('cat', 'ADHOC', headline.dedupeKey);

  const move = stats.medianDrawdownPct !== null && stats.medianDrawdownPct < 0
    ? { pct: Math.abs(stats.medianDrawdownPct), basis: `analog median drawdown over ${stats.n} events`, source: 'historical' as const }
    : ctx.vix ? { pct: round(vixDailyP90(ctx.vix.value), 2), basis: `VIX ${round(ctx.vix.value, 1)} one-day p90`, source: 'vix' as const } : null;
  const dir = headline.direction;
  const entryAt = ts + 15 * MIN;
  const close = cashCloseAfter(entryAt);
  const fit = ctx.accounts ? fitAccount(ctx.accounts, instrument, false, entryAt) : null;
  const wait = `No edge, stand aside until ${hhmm(ts + 45 * MIN)} ET.`;
  const trade = (sign: 1 | -1, text: string): TradePlan | null => move && move.pct >= 0.1
    ? buildTrade({ instrument: fit?.accountId ? fit.instrument : instrument, sign, referencePrice: ctx.referencePrice, movePct: move.pct, entryAt, entryText: text, timeStop: { at: iso(close), text: `Flat by ${hhmm(close)} ET, the cash close.` }, accountId: fit?.accountId ?? null })
    : null;
  const recoveredShare = stats.n >= 4 ? stats.recovered / stats.n : null;
  const probs = roundToOne(recoveredShare !== null ? [(stats.recovered + 0.5) / (stats.n + 1), 1 - (stats.recovered + 0.5) / (stats.n + 1)] : [0.5, 0.5]);
  const source: ScenarioBranch['probabilitySource'] = recoveredShare !== null ? 'historical' : 'prior';
  const ref = fmtPrice(ctx.referencePrice);
  // Risk-off or unclear shock: resolving is the fade back up, escalating is the leg down. Risk-on shock: the mirror.
  const resolveSign: 1 | -1 = dir > 0 ? -1 : 1;
  const resolveTrade = dir === 0 ? null : trade(resolveSign, `Second move after ${hhmm(entryAt)} ET once price is back ${resolveSign > 0 ? 'above' : 'below'} ${ref}, the pre-headline price`);
  const escalateTrade = dir === 0 ? null : trade(-resolveSign as 1 | -1, `Second move after ${hhmm(entryAt)} ET if the first ${resolveSign > 0 ? 'bounce fails under' : 'dip holds above'} ${ref}`);
  const noMag = move ? 'Headline direction is unclear.' : 'No magnitude on file: no analog sample and no VIX.';
  const mag = move?.pct ?? 0;
  const branch = (bid: string, name: string, key: string, lo: number | null, hi: number | null, p: number, sign: number, t: TradePlan | null, second: string): ScenarioBranch => ({
    id: bid, label: name, match: { metric: 'escalation', lo, hi, key }, probability: p, probabilitySource: source,
    ratesRead: { y2Bp: 0, y10Bp: 0, text: 'No rates read on an unscheduled headline.' },
    indexRead: t ? { m15Pct: round(sign * mag * 0.36, 2), h1Pct: round(sign * mag * 0.6, 2), closePct: round(sign * mag, 2), text: `${instrument} ${sign > 0 ? '+' : '−'}${mag}% (${move?.basis}).` } : { m15Pct: 0, h1Pct: 0, closePct: 0, text: 'No directional read.' },
    secondOrder: second, trade: t, ...(t ? {} : { noTradeReason: `${wait} ${noMag}` }),
  });
  const matrix: ScenarioMatrix = {
    catalystId: id, generatedAt: iso(ctx.now), referencePrice: ctx.referencePrice,
    branches: [
      branch('A', 'Resolves', 'resolves', null, 0, probs[0]!, resolveTrade ? resolveSign : 0, resolveTrade, 'Walked back, denied or contained: the shock fades.'),
      branch('B', 'Escalates', 'escalates', 0, null, probs[1]!, escalateTrade ? -resolveSign : 0, escalateTrade, 'Confirmed or followed by a second headline: the shock extends.'),
    ],
    regimeNotes: [analog, ...(ctx.profile?.regimeNotes.filter((n) => /first move/i.test(n)) ?? []), ...(fit?.excluded.map((e) => `${e.name}: ${e.reason}, excluded.`) ?? [])],
    whatIWouldDo: 'No edge until the second headline.',
    inputs: { now: ctx.now, headline, kind, analog: stats, move, referencePrice: ctx.referencePrice, instrument, probabilityBasis: recoveredShare !== null ? `recovered in ${stats.recovered} of ${stats.n} analogs` : 'stated prior', centre: 0, step: 1, mixed: null, branches: { A: { conviction: resolveTrade ? 0.55 : null }, B: { conviction: escalateTrade ? 0.55 : null } } },
  };
  return {
    id, code: 'ADHOC', name: headline.title, tier: 1, tierReason: 'impact-3 headline',
    scheduledAt: headline.ts, instruments: [instrument],
    consensus: null, prior: null, whisper: null,
    impliedMovePct: move?.pct ?? null, impliedMoveSource: move?.source ?? null,
    history: [], predictionOdds: [], matrix, status: 'live', resolution: null,
    adhoc: { headlineId: headline.id, analog },
    source: headline.source, asOf: iso(ctx.now),
  };
}
