import { describe, expect, it } from 'vitest';
import { Catalyst, MIN, ScenarioMatrix, dayKey, hhmm, zoned } from '@desk/contracts';
import type { CalendarEvent, EarningsInfo, PredictionMarket } from '@desk/contracts';
import { SIGN_TABLE, SUPPORTED_CODES, partitionErrors, regimeBand, signFor } from './branches';
import { buildCatalysts } from './build';
import { buildRateHistory } from './history';
import { impliedMove } from './implied';
import { branchNotification, matchBranch, matchRelease } from './live';
import { generateMatrix, matrixRunTimes } from './matrix';
import { asKnownAt, candlesAsOf, lastPrice, loadAccount, loadProfile, recordedEvents, regimeAsOf } from './recorded.testkit';
import type { CatalystEx, HistoricalReactionEx, MatrixCtx, Regime } from './types';

const ALL = recordedEvents();
const profile = loadProfile();

/** The catalyst and its matrix as of 20:00 ET the day before, built from nothing dated at or after that instant. */
function nightBefore(code: 'CPI' | 'NFP' | 'PPI' | 'FOMC', day: string, extra: Partial<MatrixCtx> = {}) {
  const keyed = code === 'CPI' ? 'CORE_CPI' : code;
  const target = ALL.find((e) => e.code === keyed && e.time.startsWith(day) && !/yoy/i.test(e.name))!;
  const now = Date.parse(matrixRunTimes({ scheduledAt: target.time }).dayBefore);
  const known = asKnownAt(ALL, now);
  expect(known.filter((e) => Date.parse(e.time) >= now).every((e) => e.actual === null)).toBe(true);
  const todays = known.filter((e) => e.time === target.time);
  const vixBars = candlesAsOf('VIX', now, ['1d'])['1d']!;
  const vix = vixBars[vixBars.length - 1]!;
  const catalyst = buildCatalysts(todays, [], { now, pastEvents: known, candlesByTf: candlesAsOf('NQ', now), vix: { value: vix.c, asOf: new Date(vix.t).toISOString() } }).find((c) => c.code === code)!;
  const regime = regimeAsOf(now, known);
  const ctx: MatrixCtx = { now, referencePrice: lastPrice('NQ', now), regime, predictionMarkets: [], profile, pastEvents: known, rateHistory: buildRateHistory(keyed, known, candlesAsOf('US10Y', now), 8, now), ...extra };
  const matrix = generateMatrix(catalyst, ctx);
  return { target, now, catalyst: { ...catalyst, matrix } as CatalystEx, matrix, ctx, known };
}
const actualOf = (code: string, time: string): number => ALL.find((e) => e.code === code && e.time === time && !/yoy/i.test(e.name))!.actual as number;

describe('catalyst engine acceptance', () => {
  it('for a past CPI the T-1 matrix contains the branch that occurred, with a defined entry, targets and invalidation', () => {
    for (const day of ['2026-11-10', '2026-10-14']) {
      const { target, now, catalyst, matrix, ctx } = nightBefore('CPI', day);
      expect(hhmm(now)).toBe('20:00');
      expect(dayKey(now)).toBe(dayKey(Date.parse(target.time) - 24 * 3_600_000));
      expect(catalyst.status).toBe('upcoming');
      expect(catalyst.resolution).toBeNull();
      expect(catalyst.consensus).toBe(0.2);
      expect(catalyst.secondary?.code).toBe('CPI');
      expect(catalyst.history.every((h) => Date.parse((h as HistoricalReactionEx).time) < now)).toBe(true);
      expect(ScenarioMatrix.safeParse(matrix).success).toBe(true);
      expect(Catalyst.safeParse(catalyst).success).toBe(true);
      expect(partitionErrors(matrix.branches)).toEqual([]);

      // Reveal the print.
      const actual = actualOf('CORE_CPI', target.time), headline = actualOf('CPI', target.time);
      expect(actual).toBe(0.3);
      const matching = matrix.branches.filter((b) => matchBranch(catalyst, matrix, actual, headline)?.id === b.id);
      expect(matching).toHaveLength(1);
      const lineHits = matrix.branches.filter((b) => b.match.key !== 'mixed' && (b.match.lo === null || actual >= b.match.lo) && (b.match.hi === null || actual < b.match.hi));
      expect(lineHits).toHaveLength(1);
      const branch = matching[0]!;
      expect(branch.id).toBe('C');
      expect(branch.label).toBe('Hot: 0.3%');
      console.log(`${day} as of ${new Date(now).toISOString()} ref ${ctx.referencePrice} regime ${JSON.stringify(ctx.regime)}`);
      console.log(matrix.branches.map((b) => `${b.id} ${b.label} p=${b.probability} (${b.probabilitySource}) | ${b.ratesRead.text} | ${b.indexRead.text} | ${b.trade ? `${b.trade.direction} ${b.trade.entry.text}; T ${b.trade.targets.map((t) => t.price).join('/')}; inv ${b.trade.invalidation.price}; ${b.trade.timeStop.text}` : b.noTradeReason}`).join('\n'));
      console.log(matrix.regimeNotes.join('\n'), '\n', matrix.whatIWouldDo);
      if (branch.trade) {
        const t = branch.trade;
        expect(t.direction).toBe('short');
        expect(t.entry.text).toMatch(/^Second move after 08:45 ET if the 10Y confirms/);
        expect(hhmm(t.entry.at!)).toBe('08:45');
        expect(t.targets).toHaveLength(3);
        expect(t.targets.map((x) => x.fraction).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
        expect(t.targets[0].price).toBeLessThan(ctx.referencePrice);
        expect(t.targets[1].price).toBeLessThan(t.targets[0].price);
        expect(t.targets[2].price).toBeLessThan(t.targets[1].price);
        expect(t.invalidation.price).toBeGreaterThan(ctx.referencePrice);
        expect(t.timeStop.text).toBe('Flat by 16:00 ET, the cash close.');
      } else {
        expect(branch.noTradeReason).toMatch(/^No edge, stand aside until 09:15 ET\. .+/);
      }
    }
  });

  it('the live match produces the branch notification', () => {
    const { target, catalyst, ctx } = nightBefore('CPI', '2026-11-10', { accounts: [loadAccount('mffu-pro-50k'), loadAccount('apex-50k')] });
    const T = Date.parse(target.time);
    const resolved = matchRelease(catalyst, { actual: actualOf('CORE_CPI', target.time), secondary: actualOf('CPI', target.time), ts: target.time, headlineId: 'hl_1' }, T + 2000);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toMatchObject({ actual: 0.3, branchId: 'C', headlineId: 'hl_1' });
    const n = branchNotification(resolved)!;
    console.log(n.lines.join('\n'));
    expect(n.lines).toHaveLength(3);
    expect(n.lines[0]).toBe('Core CPI 0.3% vs 0.2%. Headline 0.4% vs 0.3%.');
    expect(n.lines[1]).toMatch(/^Branch C: (Lean|Strong) short NQ 0\.\d\d, entry on second move after 08:45 ET, T1 [\d,.]+, out [\d,.]+, flat by 16:00 ET, the cash close, apex-50k\.$/);
    expect(n.plan).not.toBeNull();
    expect(n.plan!.accountId).toBe('apex-50k');
    expect(n.intent.class).toBe('P0');
    expect(n.intent.ticketPrefill).toMatchObject({ instrument: 'NQ', direction: 'short', reason: { kind: 'catalyst', catalystId: catalyst.id, branchId: 'C' } });
    expect(n.intent.ticketPrefill!.targets).toHaveLength(3);
    expect(n.intent.ticketPrefill!.referencePrice).toBe(ctx.referencePrice);
    expect(catalyst.matrix!.regimeNotes).toContain('MFFU Pro 50K: news trading is prohibited, excluded.');
    for (const l of n.lines) for (const w of profile.voice.banned) expect(l.toLowerCase()).not.toContain(w);
    const live = branchNotification(resolved, { y10: 4.95, y10ChangeBp: 9 })!;
    expect(live.lines[2]).toMatch(/^10Y \+9 bp to 4\.95%\./);
    expect(branchNotification(catalyst)).toBeNull();
  });

  it('contains the branch that occurred for the real NFP, PPI and FOMC prints too', () => {
    for (const [code, day] of [['NFP', '2026-11-06'], ['PPI', '2026-10-15'], ['FOMC', '2026-09-16'], ['FOMC', '2026-10-28']] as const) {
      const { target, catalyst, matrix } = nightBefore(code, day);
      expect(partitionErrors(matrix.branches)).toEqual([]);
      const actual = actualOf(code, target.time);
      const sec = catalyst.secondary ? actualOf(catalyst.secondary.code, target.time) : undefined;
      const lineHits = matrix.branches.filter((b) => b.match.key !== 'mixed' && (b.match.lo === null || actual >= b.match.lo) && (b.match.hi === null || actual < b.match.hi));
      if (code === 'FOMC' && actual === catalyst.prior) {
        // A hold needs the tone to split dovish from hawkish; the rate alone leaves the catalyst live.
        expect(lineHits.map((b) => b.match.key)).toEqual(['hold_dovish', 'hold_hawkish']);
        expect(matchRelease(catalyst, { actual, ts: target.time }, Date.parse(target.time)).status).toBe('live');
        expect(matchRelease(catalyst, { actual, secondary: 1, ts: target.time }, Date.parse(target.time)).resolution?.branchId).toBe('C');
      } else {
        expect(lineHits).toHaveLength(1);
        const b = matchBranch(catalyst, matrix, actual, sec)!;
        console.log(`${code} ${day}: actual ${actual} vs centre ${matrix.inputs.centre} -> ${b.id} ${b.label}`);
        expect(b.trade !== null || /^No edge, stand aside until \d\d:\d\d ET\. .+/.test(b.noTradeReason ?? '')).toBe(true);
      }
    }
  });
});

const REGIMES: Regime[] = (['hiking', 'cutting', 'hold'] as const).flatMap((fedStance) => (['uptrend', 'correction', 'downtrend'] as const).flatMap((trend) =>
  [[null, null, 30], [0.9, 0.02, 5], [0.05, 0.7, 30]].map(([hikeProb, cutProb, d]) => ({ fedStance, trend, hikeProb: hikeProb as number | null, cutProb: cutProb as number | null, y10: 4.9, y10RoundLevelDistanceBp: d as number }))));

function syntheticCatalyst(code: (typeof SUPPORTED_CODES)[number]): CatalystEx {
  const syntheticEarnings: EarningsInfo = { symbol: 'NVDA', date: '2026-12-02', timing: 'amc', epsConsensus: 1, revenueConsensus: null, whisper: null, impliedMovePct: 7, history: [], source: 'synthetic', asOf: '2026-12-01T00:00:00Z' };
  const ev: CalendarEvent = { id: `synthetic_${code}`, code, name: `synthetic ${code}`, time: '2026-12-02T13:30:00.000Z', consensus: 0.3, prior: 0.2, actual: null, source: 'synthetic', asOf: '2026-12-01T00:00:00Z' };
  const now = Date.parse('2026-12-02T01:00:00Z');
  return code === 'EARNINGS' ? buildCatalysts([], [syntheticEarnings], { now })[0]! : buildCatalysts([ev], [], { now, vix: { value: 20, asOf: '2026-12-01T21:00:00Z' } })[0]!;
}

describe('matrix invariants', () => {
  it('Branch match rules are exhaustive and non-overlapping for every supported code; probabilities sum to 1', () => {
    expect(SUPPORTED_CODES.length).toBeGreaterThanOrEqual(20);
    for (const code of SUPPORTED_CODES) {
      const catalyst = syntheticCatalyst(code);
      for (const regime of REGIMES) {
        const m = generateMatrix(catalyst, { now: Date.parse('2026-12-02T01:00:00Z'), referencePrice: 25000, regime, predictionMarkets: [], profile });
        expect(ScenarioMatrix.safeParse(m).success, code).toBe(true);
        expect(m.branches.length).toBeGreaterThanOrEqual(3);
        expect(m.branches.length).toBeLessThanOrEqual(6);
        expect(partitionErrors(m.branches), code).toEqual([]);
        expect(m.branches.reduce((a, b) => a + b.probability, 0)).toBeCloseTo(1, 9);
        // Every point on the line lands in exactly one branch (given a secondary where the interval is split).
        const edges = m.branches.flatMap((b) => [b.match.lo, b.match.hi]).filter((x): x is number => x !== null);
        for (const x of [...edges, ...edges.map((e) => e - 1e-6), ...edges.map((e) => e + 1e-6), -1e9, 1e9]) {
          for (const sec of [-1, 0, 1]) {
            const hits = m.branches.filter((b) => b.match.key !== 'mixed' && matchBranch(catalyst, { ...m, branches: m.branches.filter((y) => y.match.key !== 'mixed') }, x, sec)?.id === b.id);
            expect(hits, `${code} at ${x}/${sec}`).toHaveLength(1);
          }
        }
        for (const b of m.branches) {
          expect(b.trade === null).toBe(b.noTradeReason !== undefined);
          if (b.trade) { expect(b.trade.targets).toHaveLength(3); expect(b.trade.entry.text).not.toMatch(/\bnow\b/i); expect(Math.sign(b.indexRead.closePct)).toBe(b.trade.direction === 'long' ? 1 : -1); }
        }
      }
    }
    expect(partitionErrors([{ id: 'A', match: { metric: 'x', lo: null, hi: 1 } }, { id: 'B', match: { metric: 'x', lo: 1.1, hi: null } }])).not.toEqual([]);
    expect(partitionErrors([{ id: 'A', match: { metric: 'x', lo: null, hi: 1 } }, { id: 'B', match: { metric: 'x', lo: 0.9, hi: null } }])).not.toEqual([]);
  });

  it('re-centres the CPI branches on consensus and NFP in 50-75k steps', () => {
    const cpi = { ...syntheticCatalyst('CPI'), consensus: 0.3 };
    const m = generateMatrix(cpi, { now: 0, referencePrice: 25000, regime: REGIMES[0]!, predictionMarkets: [], profile });
    expect(m.branches.map((b) => b.label)).toEqual(['Cool: 0.2% or lower', 'In line: 0.3%', 'Hot: 0.4%', 'Very hot: 0.5% or higher']);
    expect(m.branches.map((b) => [b.match.lo, b.match.hi])).toEqual([[null, 0.25], [0.25, 0.35], [0.35, 0.45], [0.45, null]]);
    const nfp = { ...syntheticCatalyst('NFP'), consensus: 65 };
    const n = generateMatrix(nfp, { now: 0, referencePrice: 25000, regime: REGIMES[0]!, predictionMarkets: [], profile });
    expect(n.branches.map((b) => [b.match.lo, b.match.hi])).toEqual([[null, -10], [-10, 40], [40, 90], [90, 140], [140, null]]);
  });

  it('sign logic is table-driven and conditioned on the regime', () => {
    const r = (o: Partial<Regime>): Regime => ({ fedStance: 'hold', hikeProb: null, cutProb: null, trend: 'uptrend', y10: 4.5, y10RoundLevelDistanceBp: 40, ...o });
    // A hot core with hike odds high is bearish; a 0.2 with hike odds at 90% is the squeeze branch.
    expect(signFor('inflation', 1, r({ fedStance: 'hiking', hikeProb: 0.9 })).sign).toBe(-1);
    expect(signFor('inflation', 0, r({ fedStance: 'hiking', hikeProb: 0.9 })).sign).toBe(1);
    // In line with nothing priced: no edge.
    expect(signFor('inflation', 0, r({ fedStance: 'hiking', hikeProb: 0.3 })).sign).toBe(0);
    expect(signFor('inflation', 0, r({})).sign).toBe(0);
    // Cutting regime: bad growth news is good news, until it is a growth scare in a downtrend.
    expect(signFor('growth', -1, r({ fedStance: 'cutting' })).sign).toBe(1);
    expect(signFor('growth', -2, r({ fedStance: 'cutting', trend: 'downtrend' })).sign).toBe(-1);
    expect(signFor('growth', -2, r({ fedStance: 'cutting', trend: 'uptrend' })).sign).toBe(1);
    // Hiking: good news is bad news. On hold: good news is good news, unless the 10Y is at a round level.
    expect(signFor('growth', 2, r({ fedStance: 'hiking' })).sign).toBe(-1);
    expect(signFor('growth', 1, r({})).sign).toBe(1);
    expect(signFor('growth', 1, r({ y10RoundLevelDistanceBp: -6 })).sign).toBe(-1);
    // A hike that is 90% priced is not a trade; an unpriced one is.
    expect(signFor('policy', 2, r({ hikeProb: 0.9 })).sign).toBe(0);
    expect(signFor('policy', 2, r({ hikeProb: 0.3 })).sign).toBe(-1);
    expect(regimeBand(r({ cutProb: 0.7 }))).toBe('cut_priced');
    for (const fam of ['inflation', 'growth'] as const) for (const band of Object.keys(SIGN_TABLE[fam])) expect(Object.keys(SIGN_TABLE[fam][band as keyof typeof SIGN_TABLE.inflation]).length).toBeGreaterThanOrEqual(4);

    const cpi = syntheticCatalyst('CPI');
    const squeeze = generateMatrix(cpi, { now: 0, referencePrice: 25000, regime: r({ fedStance: 'hiking', hikeProb: 0.9 }), predictionMarkets: [], profile });
    expect(squeeze.branches[1]!.trade?.direction).toBe('long');
    expect(squeeze.branches[1]!.secondOrder).toBe('In line with hike odds 90%: the squeeze branch, shorts cover.');
    expect(squeeze.branches[2]!.trade?.direction).toBe('short');
    const flat = generateMatrix(cpi, { now: 0, referencePrice: 25000, regime: r({ fedStance: 'hiking', hikeProb: 0.2 }), predictionMarkets: [], profile });
    expect(flat.branches[1]!.trade).toBeNull();
    expect(flat.branches[1]!.noTradeReason).toBe('No edge, stand aside until 09:15 ET. In line with hike odds 20%, cut odds not on file: nothing new is priced.');
  });

  it('gives the hot-headline, cool-core print the mixed no-trade branch', () => {
    const { catalyst, matrix } = nightBefore('CPI', '2026-11-10');
    const mixed = matrix.branches.find((b) => b.match.key === 'mixed')!;
    expect(mixed.trade).toBeNull();
    expect(mixed.noTradeReason).toMatch(/^No edge, stand aside until 09:15 ET\. Mixed signal/);
    // consensus: core 0.2, headline 0.3
    expect(matchBranch(catalyst, matrix, 0.1, 0.4)?.id).toBe(mixed.id);
    expect(matchBranch(catalyst, matrix, 0.1, 0.3)?.id).toBe('A');
    expect(matchBranch(catalyst, matrix, 0.2, 0.5)?.id).toBe('B');
    expect(matchBranch(catalyst, matrix, 0.3, 0.4)?.id).toBe('C');
    expect(matchBranch(catalyst, matrix, 0.3)?.id).toBe('C');
  });

  it('takes probabilities from prediction-market buckets when supplied, else history, else the prior', () => {
    const { catalyst, ctx, matrix } = nightBefore('CPI', '2026-11-10');
    expect(matrix.branches[0]!.probabilitySource).toBe('historical');
    expect(String(matrix.inputs.probabilityBasis)).toMatch(/surprise distribution of the last \d+ prints/);
    const syntheticMarket: PredictionMarket = {
      id: 'synthetic-kalshi', venue: 'kalshi', title: 'synthetic core CPI MoM buckets', eventCode: 'CORE_CPI', eventDate: '2026-11-10', asOf: new Date(ctx.now - 60_000).toISOString(),
      outcomes: [{ label: '0.1 or lower', prob: 0.1, lo: null, hi: 0.15 }, { label: '0.2', prob: 0.5, lo: 0.15, hi: 0.25 }, { label: '0.3', prob: 0.3, lo: 0.25, hi: 0.35 }, { label: '0.4+', prob: 0.1, lo: 0.35, hi: null }],
    };
    const m = generateMatrix(catalyst, { ...ctx, predictionMarkets: [syntheticMarket] });
    expect(m.branches.slice(0, 4).every((b) => b.probabilitySource === 'prediction_market')).toBe(true);
    expect(Math.abs(m.branches[1]!.probability - 0.5)).toBeLessThanOrEqual(0.011);
    expect(m.branches.reduce((a, b) => a + b.probability, 0)).toBeCloseTo(1, 9);
    expect(m.branches[1]!.probability).toBeGreaterThan(m.branches[3]!.probability);
    const prior = generateMatrix(syntheticCatalyst('CPI'), { ...ctx, pastEvents: [] });
    expect(prior.branches[0]!.probabilitySource).toBe('prior');
  });

  it('writes regime notes from data: Friday lock only on a Friday, earnings fades from the history', () => {
    const fri = nightBefore('NFP', '2026-11-06');
    expect(zoned(fri.target.time).weekday).toBe(5);
    expect(fri.matrix.regimeNotes).toContain('Weekend lock on Vest at 20:00 ET Friday.');
    const tue = nightBefore('CPI', '2026-11-10');
    expect(tue.matrix.regimeNotes.some((n) => /weekend lock/i.test(n))).toBe(false);
    expect(tue.matrix.regimeNotes).toContain('First move trades the headline, second move trades yields.');
    expect(tue.matrix.regimeNotes).toContain('First move reversed in 0 of the last 1 prints with 5-minute data (8 on the table).');
    expect(tue.matrix.regimeNotes.some((n) => /hike odds not on file/.test(n))).toBe(true);

    const syntheticEarnings: EarningsInfo = {
      symbol: 'NVDA', date: '2026-12-02', timing: 'amc', epsConsensus: 1.2, revenueConsensus: null, whisper: 1.25, impliedMovePct: 7, source: 'synthetic', asOf: '2026-12-01T00:00:00Z',
      history: [{ date: '2026-08-26', surprisePct: 5, nextDayPct: -3.1 }, { date: '2026-05-27', surprisePct: 6, nextDayPct: -1.2 }, { date: '2026-02-25', surprisePct: 4, nextDayPct: 2.4 }, { date: '2025-11-19', surprisePct: 3, nextDayPct: -2.9 }],
    };
    const now = Date.parse('2026-12-02T01:00:00Z');
    const c = buildCatalysts([], [syntheticEarnings], { now })[0]!;
    expect(c.tier).toBe(1);
    expect(c.instruments).toEqual(['NVDA', 'NQ']);
    const m = generateMatrix(c, { now, referencePrice: 180, regime: REGIMES[0]!, predictionMarkets: [], profile });
    expect(m.branches.map((b) => b.match.key)).toEqual(['miss', 'inline_guide_cut', 'inline_guide_held', 'beat_guide_cut', 'beat_guide_held', 'beat_and_raise']);
    expect(m.regimeNotes).toContain('NVDA fell after 3 of its last 4 prints.');
    expect(m.regimeNotes.some((n) => /^A beat is not a positive reaction/.test(n))).toBe(true);
    const beat = m.branches.find((b) => b.match.key === 'beat_guide_held')!;
    expect(beat.trade).toBeNull();
    expect(beat.noTradeReason).toContain('NVDA fell after 3 of its last 4 beats');
    const raise = m.branches.find((b) => b.match.key === 'beat_and_raise')!;
    expect(raise.trade?.direction).toBe('long');
    expect(raise.trade?.entry.text).toMatch(/^Second move after 09:45 ET if NVDA holds above/);
    expect(dayKey(raise.trade!.entry.at!)).toBe('2026-12-03');
    expect(matchBranch(c, m, 5, 1)?.id).toBe('F');
    expect(matchBranch(c, m, 5, -1)?.id).toBe('D');
    expect(matchBranch(c, m, -6, 1)?.id).toBe('A');
  });

  it('whatIWouldDo names the top branch trade or says there is no edge', () => {
    const { matrix } = nightBefore('CPI', '2026-11-10');
    const top = [...matrix.branches].sort((a, b) => b.probability - a.probability)[0]!;
    if (top.trade) expect(matrix.whatIWouldDo).toContain(`${top.trade.direction} NQ`); else expect(matrix.whatIWouldDo).toBe('No edge until the print.');
    expect(matrix.whatIWouldDo.split('\n')).toHaveLength(1);
  });

  it('schedules the matrix at 20:00 ET the day before and 06:00 ET the day of, across DST', () => {
    expect(matrixRunTimes({ scheduledAt: '2026-11-10T13:30:00.000Z' })).toEqual({ dayBefore: '2026-11-10T01:00:00.000Z', dayOf: '2026-11-10T11:00:00.000Z' });
    expect(matrixRunTimes({ scheduledAt: '2026-07-14T12:30:00.000Z' })).toEqual({ dayBefore: '2026-07-14T00:00:00.000Z', dayOf: '2026-07-14T10:00:00.000Z' });
  });

  it('time-stops before the next Tier-1 event', () => {
    const base = nightBefore('CPI', '2026-11-10');
    const fomc = { ...syntheticCatalyst('FOMC'), id: 'synthetic_fomc', name: 'FOMC', tier: 1 as const, scheduledAt: new Date(Date.parse(base.target.time) + 330 * MIN).toISOString() };
    const m = generateMatrix(base.catalyst, { ...base.ctx, upcoming: [fomc] });
    const t = m.branches.find((b) => b.trade)!.trade!;
    expect(t.timeStop.text).toBe('Flat by 13:55 ET, before FOMC.');
  });

  it('tags the implied move with its source', () => {
    const { catalyst, now } = nightBefore('CPI', '2026-11-10');
    expect(catalyst.impliedMoveSource).toBe('historical');
    expect(catalyst.impliedMovePct).toBeGreaterThan(0);
    const syntheticDatum = { key: 'opt.implied_move.NQ', value: 1.4, source: 'synthetic', asOf: new Date(now - 60_000).toISOString(), cadenceSec: 3600 };
    expect(impliedMove(catalyst, { now, data: [syntheticDatum] })).toMatchObject({ pct: 1.4, source: 'options' });
    expect(impliedMove(catalyst, { now: now + 86_400_000, data: [syntheticDatum] }).source).toBe('historical');
    expect(impliedMove({ ...catalyst, history: [] }, { now, vix: { value: 19.92, asOf: '2026-11-09T21:00:00Z' } })).toMatchObject({ source: 'vix', pct: 2.06 });
    expect(impliedMove({ ...catalyst, history: [] }, { now })).toMatchObject({ pct: null, source: null });
  });
});
