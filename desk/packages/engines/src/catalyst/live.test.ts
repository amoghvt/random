import { describe, expect, it } from 'vitest';
import { Catalyst, MIN, type TradePlan } from '@desk/contracts';
import type { Headline } from '@desk/contracts';
import { NO_ANALOG, adhocCatalyst, adhocKind, analogStats } from './adhoc';
import { partitionErrors } from './branches';
import { buildCatalysts } from './build';
import { catalystCard } from './card';
import { branchNotification, matchBranch, matchRelease, parseReleaseHeadline, reactionClock, reanchorPlan, verdictFor } from './live';
import { generateMatrix } from './matrix';
import { asKnownAt, candlesAsOf, lastPrice, loadAccount, loadProfile, recorded, recordedEvents, regimeAsOf } from './recorded.testkit';
import { DEFAULT_INDEX_WEIGHTS, INDEX_WEIGHTS_LABEL, tierDetail, tierFor } from './tiering';
import type { CatalystEx } from './types';

const ALL = recordedEvents();
const profile = loadProfile();

function planned(code: 'CPI' | 'PPI' | 'NFP', time: string): { catalyst: CatalystEx; now: number } {
  const now = Date.parse(time) - 12 * 60 * MIN;
  const known = asKnownAt(ALL, now);
  const c = buildCatalysts(known.filter((e) => e.time === time), [], { now, pastEvents: known, candlesByTf: candlesAsOf('NQ', now) }).find((x) => x.code === code)!;
  const matrix = generateMatrix(c, { now, referencePrice: lastPrice('NQ', now), regime: regimeAsOf(now, known), predictionMarkets: [], profile, pastEvents: known });
  return { catalyst: { ...c, matrix }, now };
}
const hl = (title: string, ts: string, o: Partial<Headline> = {}): Headline => ({ id: 'hl_test', ts, source: 'synthetic-wire', title, category: 'macro', impact: 3, direction: 0, symbols: [], classifier: 'rules', dedupeKey: title.toLowerCase(), ...o });

describe('tiering', () => {
  const ev = (code: Parameters<typeof tierFor>[0]['code'], o: Partial<Parameters<typeof tierFor>[0]> = {}) => ({ code, name: code, ...o });
  it('follows the spec tiers', () => {
    for (const c of ['CPI', 'CORE_CPI', 'PPI', 'NFP', 'FOMC', 'FOMC_MINUTES', 'FED_CHAIR', 'SUMMIT'] as const) expect(tierFor(ev(c))).toBe(1);
    for (const c of ['ISM_MFG', 'ISM_SVC', 'JOLTS', 'RETAIL_SALES', 'CLAIMS', 'PCE', 'CORE_PCE', 'REGIONAL_FED', 'FED_SPEAKER'] as const) expect(tierFor(ev(c))).toBe(2);
    for (const c of ['GDP', 'OTHER'] as const) expect(tierFor(ev(c))).toBe(3);
  });
  it('tiers earnings by index weight, then watchlist, and says when the weight is missing', () => {
    expect(INDEX_WEIGHTS_LABEL).toBe('approximate, as of 2026-11, override via config');
    expect(Object.values(DEFAULT_INDEX_WEIGHTS).every((w) => w > 5)).toBe(true);
    expect(tierFor(ev('EARNINGS', { symbol: 'NVDA' }))).toBe(1);
    expect(tierDetail(ev('EARNINGS', { symbol: 'NVDA' })).reason).toContain(INDEX_WEIGHTS_LABEL);
    expect(tierFor(ev('EARNINGS', { symbol: 'NVDA' }), { indexWeights: { NVDA: 4.9 } })).toBe(2);
    expect(tierDetail(ev('EARNINGS', { symbol: 'AMZN' }))).toEqual({ tier: 2, reason: 'AMZN is on the watchlist; index weight for AMZN not supplied' });
    expect(tierFor(ev('EARNINGS', { symbol: 'AMZN' }), { indexWeights: { AMZN: 5.4 } })).toBe(1);
    expect(tierFor(ev('EARNINGS', { symbol: 'KO' }))).toBe(3);
  });
  it('promotes a coupon auction only when the 10Y is within 10 bp of a round level', () => {
    const a = ev('TREASURY_AUCTION', { name: '10-Year Note Auction' });
    expect(tierFor(a, { y10RoundLevelDistanceBp: 8 })).toBe(2);
    expect(tierFor(a, { y10RoundLevelDistanceBp: -10 })).toBe(2);
    expect(tierFor(a, { y10RoundLevelDistanceBp: 14 })).toBe(3);
    expect(tierFor(a)).toBe(3);
    expect(tierFor(ev('TREASURY_AUCTION', { name: '4-Week Bill Auction' }), { y10RoundLevelDistanceBp: 2 })).toBe(3);
    expect(tierFor(ev('IPO', { symbol: 'ANTH' }), { majorIpos: ['ANTH'] })).toBe(1);
    expect(tierFor(ev('IPO', { symbol: 'XYZ' }))).toBe(3);
  });
});

describe('buildCatalysts', () => {
  it('merges CPI headline and core into one catalyst keyed on core MoM, with stable ids', () => {
    const now = Date.parse('2026-11-10T01:00:00Z');
    const day = asKnownAt(ALL, now).filter((e) => e.time.startsWith('2026-11-10'));
    expect(day.filter((e) => e.code === 'CPI' || e.code === 'CORE_CPI').length).toBeGreaterThanOrEqual(2);
    const a = buildCatalysts(day, [], { now, y10RoundLevelDistanceBp: 14 });
    const b = buildCatalysts([...day].reverse(), [], { now, y10RoundLevelDistanceBp: 14 });
    const cpi = a.filter((c) => c.code === 'CPI');
    expect(cpi).toHaveLength(1);
    expect(cpi[0]).toMatchObject({ name: 'CPI (core MoM)', tier: 1, consensus: 0.2, prior: 0.3, keyedOn: 'CORE_CPI', status: 'upcoming', secondary: { code: 'CPI', name: 'Inflation Rate MoM', consensus: 0.3 } });
    expect(b.map((c) => c.id).sort()).toEqual(a.map((c) => c.id).sort());
    expect(a.find((c) => c.code === 'TREASURY_AUCTION')?.tier).toBe(3);
    for (const c of a) expect(Catalyst.safeParse(c).success).toBe(true);
  });
  it('carries unemployment as the payrolls secondary', () => {
    const now = Date.parse('2026-11-06T01:00:00Z');
    const nfp = buildCatalysts(asKnownAt(ALL, now).filter((e) => e.time.startsWith('2026-11-06')), [], { now }).filter((c) => c.code === 'NFP');
    expect(nfp).toHaveLength(1);
    expect(nfp[0]).toMatchObject({ consensus: 65, secondary: { code: 'UNEMPLOYMENT', consensus: 4.2 } });
  });
});

describe('re-anchoring a night-before plan', () => {
  // Synthetic plan: a short written at 25,000 the night before, with NQ 300 points lower at the release.
  const plan: TradePlan = {
    instrument: 'NQ', direction: 'short', referencePrice: 25_000,
    entry: { kind: 'condition', text: 'synthetic second move', at: '2026-12-10T13:45:00.000Z' },
    targets: [{ price: 24_900, fraction: 1 / 3 }, { price: 24_800, fraction: 1 / 3 }, { price: 24_700, fraction: 1 / 3 }],
    invalidation: { price: 25_060, reason: 'synthetic invalidation' }, timeStop: { text: 'Flat by 16:00 ET' },
  };
  it('keeps every distance and moves the levels to the new price', () => {
    const r = reanchorPlan(plan, 24_700.3);
    expect(r.referencePrice).toBe(24_700.3);
    expect(r.targets.map((t) => t.price)).toEqual([24_600.25, 24_500.25, 24_400.25]);
    expect(r.invalidation.price).toBe(24_760.25);
    expect(reanchorPlan(plan, 25_000)).toBe(plan);
  });
  it('the release push shows levels from the price at release, not the night before', () => {
    const c = { matrix: { branches: [{ id: 'C', label: 'Hot', trade: plan, secondOrder: 'synthetic', ratesRead: { text: 'synthetic' } }], inputs: {} }, resolution: { branchId: 'C', actual: 0.4, resolvedAt: '2026-12-10T13:30:01.000Z' }, code: 'CORE_CPI', name: 'Core CPI', tier: 1, id: 'cat_x', instruments: ['NQ'] } as unknown as CatalystEx;
    expect(branchNotification(c)!.plan!.targets[0].price).toBe(24_900);
    const moved = branchNotification(c, undefined, 24_700)!;
    expect(moved.plan!.targets[0].price).toBe(24_600);
    expect(moved.lines[1]).toContain('T1 24,600');
  });
});

describe('live handling', () => {
  const { catalyst } = planned('CPI', '2026-11-10T13:30:00.000Z');

  it('parses a wire headline strictly', () => {
    const at = '2026-11-10T13:30:04.000Z';
    expect(parseReleaseHeadline(hl('US Core CPI MoM 0.3% vs 0.2% expected', at), catalyst)).toEqual({ actual: 0.3, ts: at, headlineId: 'hl_test' });
    expect(parseReleaseHeadline(hl('US CPI MoM 0.4% vs 0.3% exp; Core CPI MoM 0.3% vs 0.2% exp', at), catalyst)).toEqual({ actual: 0.3, secondary: 0.4, ts: at, headlineId: 'hl_test' });
    expect(parseReleaseHeadline(hl('US Core CPI (M/M) 0.3%', at), catalyst)?.actual).toBe(0.3);
    // Not sure means null.
    expect(parseReleaseHeadline(hl('US Core CPI YoY 3.1% vs 3.0% expected', at), catalyst)).toBeNull();
    expect(parseReleaseHeadline(hl('US CPI MoM 0.4% vs 0.3% expected', at), catalyst)).toBeNull();
    expect(parseReleaseHeadline(hl('US Core CPI MoM 0.3% vs 0.4% expected', at), catalyst)).toBeNull();
    expect(parseReleaseHeadline(hl('US Core CPI MoM expected to print 0.3%', at), catalyst)).toBeNull();
    expect(parseReleaseHeadline(hl('Preview: US Core CPI MoM 0.3% seen at consensus', at), catalyst)).toBeNull();
    expect(parseReleaseHeadline(hl('US Core CPI MoM 0.3', at), catalyst)).toBeNull();
    expect(parseReleaseHeadline(hl('US Core CPI MoM 0.3%; Core CPI MoM 0.2%', at), catalyst)).toBeNull();
    expect(parseReleaseHeadline(hl('US Core CPI MoM 0.3% vs 0.2% expected', '2026-11-10T13:20:00.000Z'), catalyst)).toBeNull();
    expect(parseReleaseHeadline(hl('Canada Core PPI MoM 0.3%', at), catalyst)).toBeNull();
  });

  it('parses payrolls and a Fed decision', () => {
    const nfp = planned('NFP', '2026-11-06T13:30:00.000Z').catalyst;
    expect(parseReleaseHeadline(hl('US Non-Farm Payrolls 165K vs 65K expected; Unemployment Rate 4.1% vs 4.2% expected', '2026-11-06T13:30:02.000Z'), nfp)).toMatchObject({ actual: 165, secondary: 4.1 });
    expect(parseReleaseHeadline(hl('US Non-Farm Payrolls 165 vs 65 expected', '2026-11-06T13:30:02.000Z'), nfp)).toBeNull();
    const syntheticFomc = { ...catalyst, code: 'FOMC' as const, prior: 4, scheduledAt: '2026-12-09T19:00:00.000Z' };
    expect(parseReleaseHeadline(hl('Fed raises rates by 25 bps', '2026-12-09T19:00:01.000Z'), syntheticFomc)?.actual).toBe(4.25);
    expect(parseReleaseHeadline(hl('FOMC leaves rates unchanged', '2026-12-09T19:00:01.000Z'), syntheticFomc)?.actual).toBe(4);
    expect(parseReleaseHeadline(hl('Fed holds rates, one member wanted to cut 25 bps', '2026-12-09T19:00:01.000Z'), syntheticFomc)).toBeNull();
  });

  it('goes from headline to resolved branch in one synchronous pass', () => {
    const rel = parseReleaseHeadline(hl('US CPI MoM 0.4% vs 0.3% exp; Core CPI MoM 0.3% vs 0.2% exp', '2026-11-10T13:30:04.000Z'), catalyst)!;
    const out = matchRelease(catalyst, rel, Date.parse('2026-11-10T13:30:05.000Z'));
    expect(out.resolution).toEqual({ actual: 0.3, branchId: 'C', resolvedAt: '2026-11-10T13:30:04.000Z', headlineId: 'hl_test' });
    expect(out.secondary?.actual).toBe(0.4);
    expect(Catalyst.safeParse(out).success).toBe(true);
    expect(matchRelease({ ...catalyst, matrix: null }, rel, 0).resolution?.branchId).toBeNull();
  });

  it('reaction clock: real 2026-11-13 PPI on recorded 1m candles, no base rate where the table is thin', () => {
    const { catalyst: ppi } = planned('PPI', '2026-11-13T13:30:00.000Z');
    const T = Date.parse(ppi.scheduledAt);
    const m1 = recorded('NQ', '1m');
    const early = reactionClock(ppi, m1, T + 2 * MIN);
    expect(early.reaction).toMatchObject({ m5Pct: null, m15Pct: null, verdict: null });
    const at6 = reactionClock(ppi, m1, T + 6 * MIN);
    expect(at6.reaction!.m5Pct).not.toBeNull();
    expect(at6.reaction!.m15Pct).toBeNull();
    const at16 = reactionClock(ppi, m1, T + 16 * MIN);
    const p0 = m1.find((c) => c.t === T - MIN)!.c, p5 = m1.find((c) => c.t === T + 4 * MIN)!.c, p15 = m1.find((c) => c.t === T + 14 * MIN)!.c;
    expect(at16.reaction!.m5Pct).toBeCloseTo((p5 / p0 - 1) * 100, 3);
    expect(at16.reaction!.m15Pct).toBeCloseTo((p15 / p0 - 1) * 100, 3);
    // Only two PPI prints sit inside the 5m window, so there is no 5m/15m base rate.
    expect(ppi.history.filter((h) => h.m5Pct !== null).length).toBeLessThan(4);
    expect(at16.reaction!.verdict).toBeNull();
    expect(at16.reaction!.text).toMatch(/No base rate yet/);
    const at61 = reactionClock(ppi, m1, T + 61 * MIN);
    console.log(at16.reaction!.text, '\n', at61.reaction!.text);
    expect(['normal', 'muted', 'extreme']).toContain(at61.reaction!.verdict);
    expect(at61.reaction!.text).toMatch(/first hour median is [\d.]+% over 8 prints/);
  });

  it('verdict thresholds sit on the historical distribution', () => {
    const sample = [0.2, -0.4, 0.5, -0.6, 0.8, 1.0, -0.3, 0.7];
    expect(verdictFor(0.1, sample)).toBe('muted');
    expect(verdictFor(-0.5, sample)).toBe('normal');
    expect(verdictFor(-2, sample)).toBe('extreme');
    expect(verdictFor(0.5, [0.2, 0.3, 0.4])).toBeNull();
  });
});

describe('ad-hoc catalysts', () => {
  const now = Date.parse('2026-11-19T15:00:00Z');
  const h = hl('Chipmaker CEO resigns effective immediately', '2026-11-19T14:58:00.000Z', { category: 'company', direction: -1, symbols: ['NVDA'] });

  it('ignores anything below impact 3', () => {
    expect(adhocCatalyst({ ...h, impact: 2 }, { now, referencePrice: 180 })).toBeNull();
  });

  it('says there is no analog sample rather than quoting a number', () => {
    const c = adhocCatalyst(h, { now, referencePrice: 180 })!;
    expect(adhocKind(h.title).kind).toBe('founder_departure');
    expect(c.adhoc).toEqual({ headlineId: 'hl_test', analog: `Nearest analog, forced founder or CEO departure: ${NO_ANALOG}.` });
    expect(c.adhoc!.analog).not.toMatch(/\d/);
    expect(c.matrix!.branches.map((b) => b.label)).toEqual(['Resolves', 'Escalates']);
    expect(partitionErrors(c.matrix!.branches)).toEqual([]);
    expect(c.matrix!.branches.reduce((a, b) => a + b.probability, 0)).toBeCloseTo(1, 9);
    expect(c.matrix!.branches.every((b) => b.trade === null && /No magnitude on file/.test(b.noTradeReason ?? ''))).toBe(true);
    expect(c.matrix!.branches.every((b) => b.probabilitySource === 'prior')).toBe(true);
    expect(Catalyst.safeParse(c).success).toBe(true);
    expect(matchBranch(c, c.matrix!, 1)?.id).toBe('B');
    expect(matchBranch(c, c.matrix!, -1)?.id).toBe('A');
  });

  it('computes analog drawdown and recovery from recorded daily candles for dated events', () => {
    // Dated events are the two real hot core-CPI prints in the recorded calendar; the candles are recorded NQ dailies.
    const daily = recorded('NQ', '1d');
    const events = [{ kind: 'hot_cpi', date: '2026-10-14', label: 'Core CPI 0.3 vs 0.2' }, { kind: 'hot_cpi', date: '2026-11-10', label: 'Core CPI 0.3 vs 0.2' }, { kind: 'other_kind', date: '2026-09-11', label: 'unrelated' }];
    const s = analogStats('hot_cpi', daily, events);
    console.log(s.text, JSON.stringify(s.events));
    expect(s.n).toBe(2);
    const i = daily.findIndex((c) => new Date(c.t).toISOString().startsWith('2026-10-14'));
    const base = daily[i - 1]!.c;
    const low = Math.min(...daily.slice(i, i + 21).map((c) => c.l));
    expect(s.events[0]!.drawdownPct).toBeCloseTo((low / base - 1) * 100, 2);
    expect(s.medianDrawdownPct).toBeLessThan(0);
    expect(analogStats('hot_cpi', daily, [])).toMatchObject({ n: 0, medianDrawdownPct: null, medianRecoverySessions: null, text: NO_ANALOG });
    expect(analogStats('hot_cpi', daily, [{ kind: 'hot_cpi', date: '2015-01-05', label: 'before the recording' }]).n).toBe(0);

    const c = adhocCatalyst({ ...h, symbols: [] }, { now, referencePrice: lastPrice('NQ', now), analogEvents: events.slice(0, 2).map((e) => ({ ...e, kind: 'founder_departure' })), analogCandles: daily, accounts: [loadAccount('mffu-pro-50k')] })!;
    expect(c.adhoc!.analog).toContain('2 analogs on NQ: median drawdown');
    expect(c.impliedMoveSource).toBe('historical');
    const [resolves, escalates] = c.matrix!.branches;
    expect(resolves!.trade?.direction).toBe('long');
    expect(escalates!.trade?.direction).toBe('short');
    expect(escalates!.trade?.accountId).toBe('mffu-pro-50k');
    expect(escalates!.trade!.targets[0].price).toBeLessThan(c.matrix!.referencePrice);
  });
});

describe('catalyst card', () => {
  it('lays the matrix, the history mini-table, the countdown and the one line out for the UI', () => {
    const { catalyst } = planned('CPI', '2026-11-10T13:30:00.000Z');
    const card = catalystCard(matchRelease(catalyst, { actual: 0.3, secondary: 0.4, ts: catalyst.scheduledAt }, Date.parse(catalyst.scheduledAt)));
    expect(card).toMatchObject({ name: 'CPI (core MoM)', tier: 1, countdownTo: '2026-11-10T13:30:00.000Z', whenET: '08:30 ET', consensus: '0.2%', prior: '0.3%', status: 'resolved' });
    expect(card.rows).toHaveLength(5);
    expect(card.rows.filter((r) => r.matched).map((r) => r.branchId)).toEqual(['C']);
    expect(card.rows.every((r) => r.size === null)).toBe(true);
    expect(card.rows[2]!.trade).toMatch(/^Short NQ\. Second move after 08:45 ET .* T1 [\d,.]+, T2 [\d,.]+, T3 [\d,.]+, a third each\. Out [\d,.]+\. Flat by 16:00 ET, the cash close\.$/);
    expect(card.rows[1]!.trade).toMatch(/^No edge, stand aside until 09:15 ET\./);
    expect(card.history).toHaveLength(8);
    expect(card.history[0]).toMatchObject({ date: '2026-10-14', actual: '0.3', consensus: '0.2', firstMoveReversed: 'no', resolution: '5m' });
    expect(card.oneLine).toBe(catalyst.matrix!.whatIWouldDo);
    expect(card.impliedMove).toMatch(/% \(historical\)$/);
    const tier3 = buildCatalysts([{ id: 'synthetic', code: 'OTHER', name: 'synthetic Exports', time: '2026-12-08T13:30:00.000Z', consensus: null, prior: 1, actual: null, source: 'synthetic', asOf: '2026-12-01T00:00:00Z' }], [], { now: 0 })[0]!;
    expect(catalystCard(tier3)).toMatchObject({ tier: 3, rows: [], oneLine: 'Shown, not planned.' });
  });
});
