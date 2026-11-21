/**
 * Acceptance tests on the recorded Nov 16 and Nov 17 2026 sessions (NQ and ES 1m, Yahoo, delayed).
 * The detectors run as the live loop runs them: minute by minute, seeing only candles closed by `now`.
 * Every number asserted here is what the detectors report on the recording with their default parameters.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { StructureEvent, dayKey, fromZoned, hhmm, type Candle, type Timeframe } from '@desk/contracts';
import { hasRecorded, loadRecordedCandles } from '@desk/feeds';
import { BASE_RATE_PATTERNS, baseRateText, computeBaseRates } from './baseRates';
import { aggregate, sessionSlice } from './candles';
import { chartLevels } from './chartLevels';
import { loadSessionFixture, type SessionFixture } from './loadFixture';
import { walkForward, type FirstSeen } from './replay';
import { runDetectors } from './run';
import { diffEvents, generateUpdates, type WatcherState } from './updates';

let fx: SessionFixture;
beforeAll(() => { fx = loadSessionFixture(); });

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);
const walk = (from: number, to: number): Map<string, FirstSeen> =>
  walkForward({ instrument: 'NQ', m1: fx.m1.NQ!, history: { '15m': fx.m15History.NQ! }, peersM1: { ES: fx.m1.ES! }, from, to });
/** Events that first appeared after the first step (the first step also surfaces everything already on the chart). */
const emitted = (seen: Map<string, FirstSeen>, from: number): FirstSeen[] => [...seen.values()].filter((s) => s.at > from);
const candlesAt = (now: number): Partial<Record<Timeframe, Candle[]>> => {
  const m1 = fx.m1.NQ!.filter((k) => k.t + 60_000 <= now);
  return { '1m': m1.slice(-1500), '5m': aggregate(m1, '5m'), '15m': [...fx.m15History.NQ!, ...aggregate(m1, '15m')], '1h': aggregate([...fx.m15History.NQ!, ...aggregate(m1, '15m')], '1h'), '1d': fx.d1History.NQ! };
};

describe('recorded fixture', () => {
  it('holds the Nov 16 and Nov 17 2026 ET sessions as recorded', () => {
    const d16 = sessionSlice(fx.m1.NQ!, '2026-11-16', 'et_day'), d17 = sessionSlice(fx.m1.NQ!, '2026-11-17', 'et_day');
    const hi = (c: Candle[]): Candle => c.reduce((m, k) => (k.h > m.h ? k : m)), lo = (c: Candle[]): Candle => c.reduce((m, k) => (k.l < m.l ? k : m));
    expect([Math.round(hi(d16).h), hhmm(hi(d16).t), Math.round(lo(d16).l), hhmm(lo(d16).t)]).toEqual([27853, '03:50', 27181, '18:43']);
    expect([Math.round(lo(d17).l), hhmm(lo(d17).t), Math.round(hi(d17).h), hhmm(hi(d17).t)]).toEqual([26659, '10:54', 27605, '18:12']);
    expect(fx.m1.ES!.length).toBeGreaterThan(3000);
    expect(fx.m1.NQ!.every((k) => k.source === 'yahoo:recorded')).toBe(true);
    // CME halt 17:00-18:00 ET is a gap, not filled; Yahoo reports zero volume on the 18:00 reopen minute.
    expect(fx.m1.NQ!.some((k) => k.t >= et(17, 17, 0) && k.t < et(17, 18, 0))).toBe(false);
    expect(fx.m1.NQ!.find((k) => k.t === et(17, 18, 0))!.v).toBe(0);
  });
});

describe('chart watcher acceptance (recorded NQ 1m, walk-forward)', () => {
  it("on the Nov 16 fixture it flags 'bounce stalled under 50%' before the last hour", () => {
    const from = et(16, 9, 30), lastHour = et(16, 15, 0);
    const seen = emitted(walk(from, et(16, 16, 0)), from);
    const stalls = seen.filter((s) => s.event.kind === 'bounce_stalled_under_50' && s.event.tf === '15m');
    expect(stalls).toHaveLength(1);
    const { event: e, at } = stalls[0]!;
    // 11:30 ET high 27,621.50 to 13:30 ET low 27,235.50 is a 386-pt drop (3.8 ATR). The bounce topped at 27,413.00 (13:45 ET),
    // 46.0% of it, under the 50% level 27,428.50. The lower high is confirmed when the 14:15 candle closes: 14:30 ET.
    expect(hhmm(at)).toBe('14:30');
    expect(at).toBeLessThan(lastHour);
    expect(e.ts).toBe(new Date(et(16, 14, 30)).toISOString());
    expect(e.data).toMatchObject({ legFromT: et(16, 11, 30), legToT: et(16, 13, 30), legFrom: 27621.5, legTo: 27235.5, legPts: 386, retraceExtreme: 27413, halfLevel: 27428.5, stallCount: 1 });
    expect(e.data.retracePct as number).toBeCloseTo(45.98, 1);
    expect(e).toMatchObject({ detector: 'retrace_quality', instrument: 'NQ', bias: -1, level: 27413, confirmedSetup: false });
    expect(e.text).toBe('NQ 15m bounce stalled at 46% of the 11:30 drop (27,622 to 27,236): lower high 27,413 at 13:45 ET, 50% is 27,429. Bounce stalled under 50%: bear flag until 27,429 is reclaimed.');
    // It was not on the chart one minute earlier, and price never closed back above the 50% level into the close.
    expect(seen.some((s) => s.event.kind === 'bounce_through_50' && s.event.data.legFromT === et(16, 11, 30) && s.event.tf === '15m')).toBe(false);
    // What the recording does not support: the bounce was not on lighter volume. 22,281 a candle against 16,205 on the drop.
    const vol = seen.find((s) => s.event.detector === 'volume_context' && s.event.tf === '15m' && s.event.data.legFromT === et(16, 11, 30))!;
    expect(vol.event.kind).toBe('bounce_volume_above_impulse');
    expect(vol.event.data.volumePctOfImpulse as number).toBeCloseTo(137.5, 0);
    // The last hour then compressed under the session midpoint, flagged at 15:30 ET.
    const comp = seen.find((s) => s.event.kind === 'last_hour_compression_under_mid' && s.event.tf === '15m')!;
    expect(hhmm(comp.at)).toBe('15:30');
    expect(Math.round(comp.event.data.rangePctOfSession as number)).toBe(28);
  });

  it('on Nov 17 it flags the 18:00 spike as rejected on sub-impulse volume', () => {
    const from = et(17, 17, 0);
    const seen = emitted(walk(from, et(17, 19, 0)), from);
    const spikes = seen.filter((s) => s.event.kind.startsWith('spike_rejected') && s.event.tf === '15m');
    expect(spikes).toHaveLength(1);
    const { event: e, at } = spikes[0]!;
    // 16:45 ET candle closed 27,126.00; the 18:00 ET reopen candle traded to 27,605.25 (+479.25, through the 15m 200 EMA at 27,464)
    // and the next candle closed 27,433.50, back under it. Known at that close: 18:30 ET.
    expect(e.kind).toBe('spike_rejected');
    expect(hhmm(at)).toBe('18:30');
    expect(dayKey(at)).toBe('2026-11-17');
    expect(e.data).toMatchObject({
      direction: 'up', points: 479.25, extreme: 27605.25, extremeT: et(17, 18, 0), baseClose: 27126, emaPierced: [200],
      rejectedVia: 'ema', rejectedViaEma: 200, rejectedWithinCandles: 1, rejectedWithinMin: 30, rejectionClose: 27433.5,
      spikeVolPerCandle: 10924, impulseFromT: et(17, 6, 30), impulseToT: et(17, 10, 45), impulsePts: 809.25, crossSession: true,
    });
    expect(Math.round(e.data.emaLevel as number)).toBe(27464);
    // Sub-impulse: 10,924 contracts in the spike candle against 20,248 a candle on the 06:30-10:45 ET drop (27,468 to 26,659).
    expect(e.data.volumePctOfImpulse as number).toBeCloseTo(53.95, 1);
    expect(e.data.volumePctOfImpulse as number).toBeLessThan(100);
    expect(e).toMatchObject({ detector: 'volume_context', bias: -1, level: 27605.25, confirmedSetup: false });
    expect(e.text).toBe('NQ 15m +479 pts to 27,605 at 18:00 ET through the 200 EMA (27,464), rejected within 1 candle: close 27,434. Spike, rejected, volume 54% of the 06:30 impulse (different session: overnight volume runs lighter). Covering, not accumulation.');
    expect(e.text).not.toMatch(/buying|institutional/i);
    // Limits of the recording, asserted so they stay visible: the 1m and 5m tapes do not flag this spike.
    // The reopen gapped above every 1m/5m EMA, so no later candle starts under one, and 18:07-18:10 ET is missing.
    expect(seen.filter((s) => s.event.kind.startsWith('spike_rejected') && (s.event.tf === '1m' || s.event.tf === '5m'))).toHaveLength(0);
    expect(fx.m1.NQ!.filter((k) => k.t >= et(17, 18, 7) && k.t < et(17, 18, 11))).toHaveLength(0);
  });

  it('is deterministic on the recording and never changes an id on a re-run', () => {
    const now = et(17, 18, 30);
    const input = { instrument: 'NQ', candles: candlesAt(now), peers: { ES: aggregate(fx.m1.ES!.filter((k) => k.t + 60_000 <= now), '15m') }, now };
    const a = runDetectors(input), b = runDetectors(input);
    expect(a.length).toBeGreaterThan(500);
    expect(b).toEqual(a);
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
    for (const e of a) expect(StructureEvent.safeParse(e).success).toBe(true);
    expect(new Set(a.map((e) => e.detector))).toEqual(new Set(['swing', 'liquidity_pool', 'sweep_reclaim', 'mss', 'bos', 'fvg', 'order_block', 'ema_posture', 'retrace_quality', 'divergence', 'volume_context', 'range_compression']));
    // Both sides of the book on every timeframe.
    for (const tf of ['1m', '5m', '15m', '1h', '1d'] as const) {
      expect(a.filter((e) => e.tf === tf && e.kind === 'buy_side_liquidity')).toHaveLength(1);
      expect(a.filter((e) => e.tf === tf && e.kind === 'sell_side_liquidity')).toHaveLength(1);
    }
    // Setups are only ever sweep-and-reclaim plus MSS.
    const setups = a.filter((e) => e.confirmedSetup);
    expect(setups.length).toBeGreaterThan(0);
    expect(setups.every((e) => e.detector === 'sweep_reclaim' && /^sweep_reclaim_mss_(long|short)$/.test(e.kind))).toBe(true);
    const levels = chartLevels(a);
    expect(levels.emas.filter((x) => x.tf === '15m').map((x) => x.period)).toEqual([20, 50, 200]);
    expect(levels.fvgs.length + levels.orderBlocks.length + levels.liquidity.length).toBeGreaterThan(5);
  });

  it('pushes the Nov 17 spike once through the update loop, under 280 characters', () => {
    let state: WatcherState | null = null;
    const pushed: string[] = [];
    for (let now = et(17, 18, 0); now <= et(17, 19, 0); now += 60_000) {
      const all = runDetectors({ instrument: 'NQ', candles: { '15m': candlesAt(now)['15m'] }, now });
      const fresh = diffEvents(state, all);
      const lastPrice = fx.m1.NQ!.filter((k) => k.t + 60_000 <= now).at(-1)!.c;
      const r = generateUpdates({ now, instrument: 'NQ', events: state ? fresh : [], allEvents: all, lastPrice, call: null, positions: [], tickets: [], prevState: state });
      state = r.state;
      for (const u of r.updates) { expect(u.text.length).toBeLessThanOrEqual(280); pushed.push(`${hhmm(u.ts)} ${u.text}`); }
    }
    expect(pushed.filter((t) => t.includes('spike'))).toEqual(['18:30 NQ 27,434, 15m spike +479 pts to 27,605, rejected, volume 54% of the 06:30 impulse.']);
  });
});

describe('base rates', () => {
  it('are computed from candles with a definition, n and window, and read "n too small" under 10', () => {
    const m15 = [...fx.m15History.NQ!, ...aggregate(fx.m1.NQ!, '15m')];
    const now = et(18, 0, 0);
    const rates = computeBaseRates({ '15m': m15 }, now);
    expect(rates.map((r) => r.pattern)).toEqual(BASE_RATE_PATTERNS.map((p) => p.pattern));
    for (const r of rates) {
      expect(r).toMatchObject({ instrument: 'NQ', tf: '15m', windowDays: 23, asOf: new Date(now).toISOString() });
      expect(r.definition).toMatch(/1 ATR\(14\) in the pattern's direction before 1 ATR against it, within 16 candles/);
      expect(r.hitRate).toBeGreaterThanOrEqual(0);
      expect(r.hitRate).toBeLessThanOrEqual(1);
      expect(baseRateText(r)).toMatch(r.n < 10 ? /: n too small \(n=\d+, 23 days\)$/ : /: \d+% in the last 23 days \(n=\d+\)$/);
    }
    expect(computeBaseRates({ '15m': m15 }, now)).toEqual(rates);
    // Events state their base rate when one is supplied.
    const sweep = rates.find((r) => r.pattern === 'sweep_reclaim_follow_through')!;
    expect(sweep.n).toBeGreaterThan(100);
    const ev = runDetectors({ instrument: 'NQ', candles: { '15m': m15 }, now, baseRates: rates }).find((e) => e.kind === 'sweep_reclaim_low')!;
    expect(ev.text.endsWith(`Base rate, ${baseRateText(sweep)}.`)).toBe(true);
    expect(ev.data.baseRate).toMatchObject({ n: sweep.n, hitRate: sweep.hitRate, windowDays: 23 });
  });

  it.skipIf(!hasRecorded('NQ', '15m') || !hasRecorded('NQ', '1h'))('run on the recorded NQ 15m and 1h archive', () => {
    const m15 = loadRecordedCandles('NQ', '15m'), h1 = loadRecordedCandles('NQ', '1h');
    const rates = computeBaseRates({ '15m': m15, '1h': h1 }, Math.max(m15.at(-1)!.t, h1.at(-1)!.t) + 3_600_000);
    expect(rates).toHaveLength(8);
    expect(rates.filter((r) => r.tf === '1h').every((r) => r.windowDays <= 90)).toBe(true);
    expect(rates.find((r) => r.tf === '15m' && r.pattern === 'sweep_reclaim_follow_through')!.n).toBeGreaterThan(300);
  });
});
