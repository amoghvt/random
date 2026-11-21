import { describe, expect, it } from 'vitest';
import { StructureEvent, fromZoned } from '@desk/contracts';
import { aggregate, ema } from './candles';
import { detectDivergence } from './detectors/divergence';
import { detectEmaPosture } from './detectors/ema';
import { detectFvgs, detectOrderBlocks, findImpulses } from './detectors/imbalance';
import { detectRange } from './detectors/range';
import { detectRetrace } from './detectors/retrace';
import { detectStructure } from './detectors/structure';
import { confirmSetups, detectSweeps } from './detectors/sweep';
import { detectLiquidity, detectSwings } from './detectors/swings';
import { detectRetraceVolume, detectSpikes } from './detectors/volume';
import { detectOnTimeframe, runDetectors } from './run';
import { SYN, synthetic, type SyntheticTape } from './synthetic.testkit';

const kinds = (es: StructureEvent[]): string[] => es.map((e) => e.kind);
const one = (es: StructureEvent[], kind: string): StructureEvent => {
  const hit = es.filter((e) => e.kind === kind);
  expect(hit, `${kind} in [${kinds(es).join(', ')}]`).toHaveLength(1);
  return hit[0]!;
};

describe('swings and liquidity pools (synthetic candles)', () => {
  // Highs 100.00 and 100.05 are within 0.1%; lows 92 and 92 are equal.
  const hl = [95, 97, 100, 97, 95, 97, 100.05, 97, 95, 96, 96];
  const tape = synthetic(95);
  for (const h of hl) tape.raw(h - 1.5, h, h - 3, h - 1.5);

  it('emits a swing per confirmed fractal', () => {
    const ev = detectSwings(tape.ctx());
    expect(ev.filter((e) => e.kind === 'swing_high').map((e) => e.level)).toEqual([100, 100.05]);
    expect(ev.filter((e) => e.kind === 'swing_low').map((e) => e.level)).toEqual([92, 92]);
    expect(ev[0]!.ts).toBe(new Date(tape.candles[4]!.t + 900_000).toISOString());
  });

  it('flags equal highs and equal lows as resting liquidity and always reports both sides', () => {
    const ev = detectLiquidity(tape.ctx());
    const eqh = one(ev, 'equal_highs'), eql = one(ev, 'equal_lows');
    expect([eqh.level, eqh.levelHi, eqh.data.touches]).toEqual([100, 100.05, 2]);
    expect(eql.level).toBe(92);
    const buy = one(ev, 'buy_side_liquidity'), sell = one(ev, 'sell_side_liquidity');
    expect(buy.level).toBe(100.05);
    expect(sell.level).toBe(92);
    for (const e of [buy, sell]) {
      expect(e.text).toContain('buy stops 100.05');
      expect(e.text).toContain('sell stops 92.00');
      expect(e.data).toMatchObject({ buySide: 100.05, sellSide: 92 });
    }
  });

  it('still reports both sides when one side has nothing resting', () => {
    const ev = detectLiquidity(synthetic(100).calm(6).to(120, 6).ctx());
    expect(one(ev, 'buy_side_liquidity').level).toBeNull();
    expect(one(ev, 'buy_side_liquidity').text).toMatch(/no buy stops inside \d+ candles/);
    expect(ev.some((e) => e.kind === 'sell_side_liquidity')).toBe(true);
  });

  it('drops a pool once price has traded through it', () => {
    const swept = synthetic(95);
    for (const h of [...hl, 101, 96, 96]) swept.raw(h - 1.5, h, h - 3, h - 1.5);
    expect(kinds(detectLiquidity(swept.ctx()))).not.toContain('equal_highs');
  });
});

describe('sweep and reclaim (synthetic candles)', () => {
  const base = (): SyntheticTape => synthetic(100).calm(6).raw(100, 100.5, 95, 99.5).calm(4);

  it('fires when price trades through a swing low and closes back above it', () => {
    const ev = detectSweeps(base().raw(100, 100.5, 94, 99).ctx());
    const e = one(ev, 'sweep_reclaim_low');
    expect(e).toMatchObject({ level: 95, bias: 1, confirmedSetup: false });
    expect(e.data).toMatchObject({ extreme: 94, depthPts: 1, candlesToReclaim: 1 });
  });

  it('allows the reclaim up to three candles after the sweep, not four', () => {
    const late = base().raw(100, 100.5, 94, 94.5).raw(94.5, 94.8, 93.5, 94).raw(94, 96, 93.8, 95.5);
    expect(one(detectSweeps(late.ctx()), 'sweep_reclaim_low').data.candlesToReclaim).toBe(3);
    const tooLate = base().raw(100, 100.5, 94, 94.5).raw(94.5, 94.8, 93.5, 94).raw(94, 94.5, 93.8, 94).raw(94, 96, 93.8, 95.5);
    expect(detectSweeps(tooLate.ctx())).toHaveLength(0);
  });

  it('mirrors for swing highs', () => {
    const tape = synthetic(100).calm(6).raw(100, 105, 99.5, 100.5).calm(4).raw(100, 106, 99.5, 101);
    expect(one(detectSweeps(tape.ctx()), 'sweep_reclaim_high')).toMatchObject({ level: 105, bias: -1 });
  });
});

describe('MSS, BOS and the confirmed setup (synthetic candles)', () => {
  it('calls a close above the last lower high an MSS and the next break with the trend a BOS', () => {
    const tape = synthetic(100).to(90, 4).to(95, 4).to(85, 4).to(90, 4).to(87, 3).to(96, 4).to(93, 3).to(100, 4);
    const ev = detectStructure(tape.ctx());
    const mss = one(ev, 'mss_bullish'), bos = one(ev, 'bos_bullish');
    expect(mss).toMatchObject({ detector: 'mss', level: 90.2, bias: 1 });
    expect(bos).toMatchObject({ detector: 'bos', level: 96.2, bias: 1 });
    expect(mss.ts < bos.ts).toBe(true);
    expect(ev.some((e) => e.kind === 'bos_bearish' || e.kind === 'mss_bearish')).toBe(true);
  });

  const swept = (): SyntheticTape => synthetic(100).to(90, 4).to(95, 4).to(85, 4).to(89, 4).to(86, 3).raw(86, 86.2, 84, 86);

  it('marks confirmedSetup only for a sweep and reclaim followed by an MSS in the reclaim direction', () => {
    const ctx = swept().to(92, 3).ctx();
    const sweeps = detectSweeps(ctx), shifts = detectStructure(ctx);
    expect(one(sweeps, 'sweep_reclaim_low').confirmedSetup).toBe(false);
    const setup = one(confirmSetups(ctx, sweeps, shifts), 'sweep_reclaim_mss_long');
    expect(setup).toMatchObject({ detector: 'sweep_reclaim', confirmedSetup: true, bias: 1, level: 89.2 });
    expect(setup.data).toMatchObject({ invalidation: 84, direction: 'long', sweptLevel: 84.8 });
    expect(detectOnTimeframe(ctx).filter((e) => e.confirmedSetup)).toHaveLength(1);
  });

  it('a sweep and reclaim alone is not a setup', () => {
    const ctx = swept().calm(3).ctx();
    const sweeps = detectSweeps(ctx);
    expect(kinds(sweeps)).toEqual(['sweep_reclaim_low']);
    expect(confirmSetups(ctx, sweeps, detectStructure(ctx))).toHaveLength(0);
    expect(detectOnTimeframe(ctx).some((e) => e.confirmedSetup)).toBe(false);
  });

  it('an MSS alone is not a setup', () => {
    const ctx = synthetic(100).to(90, 4).to(95, 4).to(85, 4).to(90, 4).to(87, 3).to(96, 4).ctx();
    expect(kinds(detectStructure(ctx))).toContain('mss_bullish');
    expect(detectOnTimeframe(ctx).some((e) => e.confirmedSetup)).toBe(false);
  });
});

describe('fair value gaps and order blocks (synthetic candles)', () => {
  const gap = (): SyntheticTape => synthetic(100).calm(20).raw(100, 101, 99, 100).raw(100, 110, 100, 110).raw(110, 112, 108, 111);

  it('finds the three-candle imbalance and tracks open, mitigated, filled', () => {
    const open = one(detectFvgs(gap().ctx()), 'fvg_bull_open');
    expect(open).toMatchObject({ level: 101, levelHi: 108, bias: 1 });
    const mit = one(detectFvgs(gap().raw(111, 111, 105, 109).ctx()), 'fvg_bull_mitigated');
    expect(mit.data.filledPct).toBeCloseTo(3 / 7);
    const filled = one(detectFvgs(gap().raw(111, 111, 105, 109).raw(109, 109, 100.5, 102).ctx()), 'fvg_bull_filled');
    expect(filled.bias).toBe(0);
    // Same gap, three states, three ids.
    expect(new Set([open.id, mit.id, filled.id]).size).toBe(3);
  });

  it('ignores gaps under a quarter of ATR', () => {
    const tape = synthetic(100).calm(20).raw(100, 101, 99, 100).raw(100, 102, 100, 102).raw(102, 103, 101.3, 102.5);
    expect(detectFvgs(tape.ctx())).toHaveLength(0);
  });

  const block = (): SyntheticTape => synthetic(100).calm(20).raw(100, 100.5, 98.5, 99).to(103, 1).to(107, 1).to(111, 1).raw(111, 111.2, 110, 110.5);

  it('marks the last down candle before a 3-ATR impulse and tracks fresh, mitigated, invalidated', () => {
    expect(findImpulses(block().ctx())).toMatchObject([{ dir: 1, net: 12 }]);
    expect(one(detectOrderBlocks(block().ctx()), 'ob_bull_fresh')).toMatchObject({ level: 98.5, levelHi: 100.5, bias: 1 });
    const back = block().to(102, 3).raw(102, 102.2, 100.2, 101.5);
    expect(one(detectOrderBlocks(back.ctx()), 'ob_bull_mitigated').level).toBe(98.5);
    expect(one(detectOrderBlocks(back.raw(101.5, 101.7, 97, 97.5).ctx()), 'ob_bull_invalidated').bias).toBe(0);
  });

  it('a slow drift is not an impulse', () => {
    expect(findImpulses(synthetic(100).calm(20).to(112, 12).raw(112, 112.2, 111, 111.5).ctx())).toHaveLength(0);
  });
});

describe('EMA posture (synthetic candles)', () => {
  const falling = (): SyntheticTape => synthetic(300).to(150, 260);

  it('reports a bearish stack with the three EMA values', () => {
    const e = one(detectEmaPosture(falling().ctx()), 'ema_stack_bear');
    expect(e.bias).toBe(-1);
    expect(e.data.ema20 as number).toBeLessThan(e.data.ema50 as number);
    expect(e.data.ema50 as number).toBeLessThan(e.data.ema200 as number);
    expect(e.text).toContain('200 declining');
  });

  it('says so when there is not enough history for the 200', () => {
    const e = one(detectEmaPosture(synthetic(300).to(250, 80).ctx()), 'ema_stack_bear');
    expect(e.data.ema200).toBeNull();
    expect(e.text).toContain('needs 200 candles, have 80');
  });

  it('first touch of a declining 200 EMA with three closes back under is a first-touch rejection', () => {
    const tape = falling();
    const e200 = ema(tape.candles.map((k) => k.c), 200).at(-1)!;
    tape.raw(150, e200 + 1, 149.5, 151).raw(151, 151.5, 150, 150.5).raw(150.5, 151, 149.5, 150);
    const ev = detectEmaPosture(tape.ctx()).filter((e) => e.data.period === 200);
    const e = one(ev, 'first_touch_rejection');
    expect(e).toMatchObject({ bias: -1 });
    expect(e.data).toMatchObject({ declining: true, side: 'from_below' });
    expect(e.text).toMatch(/first touch of the declining 200 EMA/);
    expect(kinds(ev)).not.toContain('reclaim_and_hold');
  });

  it('three straight closes above after the touch is reclaim-and-hold, not a rejection', () => {
    const tape = falling();
    const e200 = ema(tape.candles.map((k) => k.c), 200).at(-1)!;
    tape.raw(150, e200 + 3, 149.5, e200 + 2).raw(e200 + 2, e200 + 4, e200 + 1.5, e200 + 3).raw(e200 + 3, e200 + 5, e200 + 2.5, e200 + 4);
    const ev = detectEmaPosture(tape.ctx()).filter((e) => e.data.period === 200);
    expect(one(ev, 'reclaim_and_hold').bias).toBe(1);
    expect(kinds(ev)).not.toContain('first_touch_rejection');
  });

  it('a second touch is not a first touch', () => {
    const tape = falling();
    const e200 = ema(tape.candles.map((k) => k.c), 200).at(-1)!;
    tape.raw(150, e200 + 1, 149.5, 151).raw(151, 151.5, 150, 150.5).raw(150.5, 151, 149.5, 150).raw(150, e200 + 1, 149.5, 151).raw(151, 151.5, 150, 150.5).raw(150.5, 151, 149.5, 150);
    expect(detectEmaPosture(tape.ctx()).filter((e) => e.data.period === 200 && e.kind === 'first_touch_rejection')).toHaveLength(1);
  });
});

describe('retrace quality (synthetic candles)', () => {
  const drop = (): SyntheticTape => synthetic(100).calm(20).to(110, 2).to(90, 4);

  it('flags a bounce that puts in a lower high under 50% of the drop', () => {
    const tape = drop().to(96, 3).to(93, 2);
    const e = one(detectRetrace(tape.ctx()), 'bounce_stalled_under_50');
    expect(e).toMatchObject({ detector: 'retrace_quality', bias: -1, level: 96.2 });
    expect(e.data.retracePct).toBeCloseTo((6.4 / 20.4) * 100, 5);
    expect(e.data).toMatchObject({ legFrom: 110.2, legTo: 89.8, stallCount: 1 });
    expect(e.levelHi).toBeCloseTo(100);
    expect(e.text).toContain('Bounce stalled under 50%: bear flag');
    // Known only when the lower high is confirmed, two candles after it.
    expect(e.ts).toBe(new Date(tape.candles.at(-1)!.t + 900_000).toISOString());
    expect(detectRetrace(drop().to(96, 3).to(94.5, 1).ctx())).toHaveLength(0);
  });

  it('does not flag a bounce that retraced more than 50%, and reports the close through 50%', () => {
    const ev = detectRetrace(drop().to(103, 3).to(101, 2).ctx());
    expect(kinds(ev)).toEqual(['bounce_through_50']);
    expect(ev[0]!.bias).toBe(1);
  });

  it('a second stall on the same leg is the same observation at a higher severity', () => {
    const ev = detectRetrace(drop().to(96, 3).to(93, 2).to(98, 2).to(95, 2).ctx()).filter((e) => e.kind === 'bounce_stalled_under_50');
    expect(ev.map((e) => e.data.stallCount)).toEqual([1, 2]);
    expect(ev[0]!.data.obsKey).toBe(ev[1]!.data.obsKey);
    expect(ev[1]!.data.severity as number).toBeGreaterThan(ev[0]!.data.severity as number);
    expect(ev[0]!.id).not.toBe(ev[1]!.id);
  });

  it('stops tracking once the drop extends', () => {
    expect(kinds(detectRetrace(drop().to(96, 3).to(88, 2).to(86, 2).ctx()))).not.toContain('bounce_stalled_under_50');
  });

  it('mirrors for a dip that holds above 50% of a rally', () => {
    const e = one(detectRetrace(synthetic(100).calm(20).to(90, 2).to(110, 4).to(104, 3).to(107, 2).ctx()), 'dip_stalled_under_50');
    expect(e.bias).toBe(1);
  });

  it('ignores legs under 3 ATR', () => {
    expect(detectRetrace(synthetic(100).calm(20).to(102, 2).to(98, 4).to(99.2, 3).to(98.6, 2).ctx())).toHaveLength(0);
  });
});

describe('divergence (synthetic candles)', () => {
  const nq = synthetic(100).to(110, 4).to(104, 4).to(108, 4).to(102, 4);

  it('says when the peer makes lower highs too', () => {
    const peer = synthetic(50, '15m', undefined, 'ES').to(55, 4).to(52, 4).to(54, 4).to(51, 4).candles;
    const e = one(detectDivergence(nq.ctx(), 'ES', peer).filter((x) => x.data.swing === 'high'), 'both_lower_highs');
    expect(e).toMatchObject({ detector: 'divergence', bias: -1 });
    expect(e.data.short).toBe('ES lower highs too');
  });

  it('flags a higher high the instrument did not make', () => {
    const peer = synthetic(50, '15m', undefined, 'ES').to(55, 4).to(52, 4).to(56, 4).to(51, 4).candles;
    const e = one(detectDivergence(nq.ctx(), 'ES', peer).filter((x) => x.data.swing === 'high'), 'highs_diverge');
    expect(e.bias).toBe(0);
    expect(e.data).toMatchObject({ instrumentMade: 'lower_high', peerMade: 'higher_high', agree: false });
  });

  it('skips swings where the peer did not trade', () => {
    expect(detectDivergence(nq.ctx(), 'SOX', synthetic(50, '15m', undefined, 'SOX').calm(3).candles)).toHaveLength(0);
  });

  it('flags an index rally against rising yields', () => {
    const index = synthetic(100).calm(20).to(130, 20);
    const y10 = synthetic(4, '15m', undefined, 'US10Y', 0.001).calm(0).to(4.0, 20).to(4.2, 20).candles;
    const e = one(detectDivergence(index.ctx(), 'US10Y', y10), 'index_up_yields_up');
    expect(e.bias).toBe(-1);
    const flat = synthetic(4, '15m', undefined, 'US10Y', 0.001).to(4.0, 40).candles;
    expect(detectDivergence(index.ctx(), 'US10Y', flat)).toHaveLength(0);
  });
});

describe('volume context (synthetic candles)', () => {
  // Down impulse on 1,000 a candle, then a spike through the 20 EMA that closes back under it.
  const setup = (spikeVol: number): SyntheticTape => synthetic(110).calm(30, 500).to(112, 2, 500).to(96, 4, 1000).to(97, 2, 300).calm(4, 300).raw(97, 108, 96.8, 99, spikeVol);

  it('reports a rejected spike on lighter volume as spike_rejected, never as buying', () => {
    const e = one(detectSpikes(setup(300).ctx()), 'spike_rejected');
    expect(e).toMatchObject({ detector: 'volume_context', level: 108, bias: -1 });
    expect(e.data).toMatchObject({ points: 10.75, baseClose: 97.25, rejectedWithinCandles: 0, rejectedWithinMin: 15, direction: 'up' });
    expect(e.data.volumePctOfImpulse).toBeCloseTo(30);
    expect(e.text).toMatch(/Spike, rejected, volume 30% of the .* impulse/);
    expect(e.text).not.toMatch(/buying|accumulat(?!ion\.$)/i);
    expect(e.text).toContain('Covering, not accumulation.');
  });

  it('does not call it sub-impulse when the spike volume matches the impulse', () => {
    const e = one(detectSpikes(setup(2000).ctx()), 'spike_rejected_volume_at_impulse');
    expect(e.bias).toBe(0);
    expect(e.text).toContain('volume 200% of the');
    expect(e.text).not.toContain('Covering');
  });

  it('does not invent a volume read when the spike candle reports zero volume', () => {
    const e = one(detectSpikes(setup(0).ctx()), 'spike_rejected_volume_unknown');
    expect(e.data.volumePctOfImpulse).toBeNull();
    expect(e.text).toContain('volume not reported for the spike candles');
  });

  it('a spike that holds is not flagged', () => {
    const held = synthetic(110).calm(30, 500).to(112, 2, 500).to(96, 4, 1000).to(97, 2, 300).calm(4, 300).raw(97, 108, 96.8, 107.5, 300);
    for (let i = 0; i < 8; i++) held.raw(107.5, 107.8, 107, 107.5, 300);
    expect(detectSpikes(held.ctx())).toHaveLength(0);
  });

  it('a rejection on the sixth candle is too late', () => {
    const spike = (quiet: number): SyntheticTape => {
      const tape = synthetic(110).calm(30, 500).to(112, 2, 500).to(96, 4, 1000).to(97, 2, 300).calm(4, 300).raw(97, 108, 96.8, 107.5, 300);
      for (let i = 0; i < quiet; i++) tape.raw(107.5, 107.8, 107, 107.5, 300);
      return tape.raw(107.5, 107.6, 98, 98.5, 300);
    };
    const up = (tape: SyntheticTape): string[] => kinds(detectSpikes(tape.ctx())).filter((k) => k.startsWith('spike_rejected'));
    expect(up(spike(4))).toEqual(['spike_rejected']);
    expect(up(spike(5))).toEqual([]);
  });

  it('compares bounce volume with the impulse it retraces', () => {
    const tape = synthetic(100).calm(20, 500).to(110, 2, 500).to(90, 4, 1000).to(96, 3, 400).to(93, 2, 400);
    const e = one(detectRetraceVolume(tape.ctx()), 'bounce_volume_below_impulse');
    expect(e.data.volumePctOfImpulse).toBeCloseTo(40);
    expect(e.text).toContain('Covering, not accumulation.');
  });
});

describe('range and compression (synthetic candles)', () => {
  it('counts consecutive inside bars against the mother candle', () => {
    const ev = detectRange(synthetic(100).calm(5).raw(100, 105, 95, 100).raw(100, 103, 97, 101).raw(101, 102, 98, 100).ctx()).filter((e) => e.kind === 'inside_bar' && e.level === 95);
    expect(ev.map((e) => e.data.count)).toEqual([1, 2]);
  });

  it('finds a pennant: lower highs, higher lows, range halved', () => {
    const tape = synthetic(100).calm(20);
    for (let i = 0; i < 12; i++) tape.raw(100, 110 - (9 * i) / 11, 90 + (9 * i) / 11, 100);
    expect(one(detectRange(tape.ctx()), 'pennant').bias).toBe(0);
    const wide = synthetic(100).calm(20);
    for (let i = 0; i < 12; i++) wide.raw(100, 110, 90, 100);
    expect(kinds(detectRange(wide.ctx()))).not.toContain('pennant');
  });

  it('tracks the opening range: set, broken, break failed', () => {
    const tape = synthetic(100, '5m', fromZoned(2026, 1, 6, 9, 30));
    for (let i = 0; i < 6; i++) tape.raw(100, 105, 95, 100);
    tape.raw(100, 107, 100, 106).raw(106, 106.5, 99, 100);
    const ev = detectRange(tape.ctx());
    expect(one(ev, 'or_set')).toMatchObject({ level: 95, levelHi: 105 });
    expect(one(ev, 'or_break_up').bias).toBe(1);
    expect(one(ev, 'or_failed_break_up').bias).toBe(-1);
  });

  it('flags last-hour compression under the session midpoint from 15:30 ET, not before', () => {
    const build = (lastHourCandles: number): SyntheticTape => {
      const tape = synthetic(140, '5m', fromZoned(2026, 1, 6, 9, 30)).to(105, 66);
      for (let i = 0; i < lastHourCandles; i++) tape.raw(106, 108, 104, 106);
      return tape;
    };
    expect(kinds(detectRange(build(5).ctx()))).not.toContain('last_hour_compression_under_mid');
    const e = one(detectRange(build(6).ctx()), 'last_hour_compression_under_mid');
    expect(e).toMatchObject({ level: 104, levelHi: 108, bias: -1 });
    expect(e.data.midpoint as number).toBeCloseTo(122.5, 0);
    // A wide last hour is not compression.
    const loose = synthetic(140, '5m', fromZoned(2026, 1, 6, 9, 30)).to(105, 66);
    for (let i = 0; i < 6; i++) loose.raw(106, 118, 100, 106);
    expect(kinds(detectRange(loose.ctx()))).not.toContain('last_hour_compression_under_mid');
  });
});

describe('runDetectors (synthetic candles)', () => {
  const tape = synthetic(100).calm(20).to(110, 2).to(90, 4).to(96, 3).to(93, 2).to(99, 3).to(92, 4).raw(92, 93, 88, 92.5).to(101, 4);
  const now = tape.candles.at(-1)!.t + 900_000;

  it('is deterministic: same candles, same events, same ids', () => {
    const a = runDetectors({ instrument: SYN, candles: { '15m': tape.candles }, now });
    const b = runDetectors({ instrument: SYN, candles: { '15m': [...tape.candles] }, now });
    expect(a.length).toBeGreaterThan(10);
    expect(b).toEqual(a);
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
  });

  it('never looks past now: candles that have not closed change nothing', () => {
    const cut = tape.candles.length - 6;
    const asOf = tape.candles[cut]!.t;
    const withFuture = runDetectors({ instrument: SYN, candles: { '15m': tape.candles }, now: asOf });
    const withoutFuture = runDetectors({ instrument: SYN, candles: { '15m': tape.candles.slice(0, cut) }, now: asOf });
    expect(withFuture).toEqual(withoutFuture);
  });

  it('every event satisfies the contract schema and carries a numbers-first sentence', () => {
    const m5 = synthetic(100, '5m').calm(30).to(108, 3).to(99, 3).candles;
    const all = runDetectors({ instrument: SYN, candles: { '15m': tape.candles, '5m': m5, '1h': aggregate(tape.candles, '1h') }, now });
    for (const e of all) {
      expect(() => StructureEvent.parse(e)).not.toThrow();
      expect(e.text).toMatch(/^SYN (1m|5m|15m|1h|1d) /);
      expect(e.text).toMatch(/\d/);
      expect(e.text).not.toMatch(/consider|you may want|perhaps|institutional|buying/i);
    }
    expect(new Set(all.map((e) => e.tf))).toEqual(new Set(['5m', '15m', '1h']));
  });
});
