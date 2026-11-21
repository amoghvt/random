/**
 * Base rates measured on recorded candles. Nothing here is asserted: every rate carries its definition,
 * its sample count and its window, and reads "n too small" under 10 samples.
 */
import { DAY, iso, type BaseRate, type Candle, type StructureEvent, type Timeframe } from '@desk/contracts';
import { closedCandles } from './candles';
import { buildContext, type TfContext } from './core';
import { detectEmaPosture } from './detectors/ema';
import { detectRetrace } from './detectors/retrace';
import { detectSweeps } from './detectors/sweep';
import { detectSpikes } from './detectors/volume';

export const BASE_RATE_HORIZON = 16;
export const BASE_RATE_MIN_N = 10;
export const BASE_RATE_WINDOW_DAYS = 90;

const OUTCOME = `Hit = after the confirming close, price travels 1 ATR(14) in the pattern's direction before 1 ATR against it, within ${BASE_RATE_HORIZON} candles; if neither is reached the close of candle ${BASE_RATE_HORIZON} decides; both inside one candle counts as a miss. 50% is a coin flip.`;

interface PatternSpec { pattern: string; label: string; definition: string; detect: (ctx: TfContext) => StructureEvent[]; match: (e: StructureEvent) => boolean; dir: (e: StructureEvent) => 1 | -1 }

export const BASE_RATE_PATTERNS: PatternSpec[] = [
  {
    pattern: 'first_touch_rejection_declining_200ema', label: 'first-touch rejection of a declining 200 EMA',
    definition: `High reaches the 200 EMA after 20 candles entirely below it, the EMA is lower than 10 candles earlier, and the touch candle and the next two all close below it. Direction: down. ${OUTCOME}`,
    detect: detectEmaPosture, match: (e) => e.kind === 'first_touch_rejection' && e.data.period === 200 && e.data.declining === true, dir: () => -1,
  },
  {
    pattern: 'sweep_reclaim_follow_through', label: 'sweep-and-reclaim follow-through',
    definition: `Price trades through a confirmed 2-candle fractal swing low (high) and closes back above (below) it within 3 candles. Direction: the reclaim's. ${OUTCOME}`,
    detect: detectSweeps, match: (e) => e.kind === 'sweep_reclaim_low' || e.kind === 'sweep_reclaim_high', dir: (e) => (e.bias === 1 ? 1 : -1),
  },
  {
    pattern: 'bounce_stalled_under_50_continuation', label: 'bounce stalled under 50% continuing lower',
    definition: `After a down leg of at least 3 ATR between alternating fractals, the first fractal lower high forms with the bounce under 50% of the leg. Direction: down. ${OUTCOME}`,
    detect: detectRetrace, match: (e) => e.kind === 'bounce_stalled_under_50' && e.data.stallCount === 1, dir: () => -1,
  },
  {
    pattern: 'spike_rejected_low_volume_continuation', label: 'spike rejected on sub-impulse volume continuing lower',
    definition: `A rise of at least 3 ATR in at most 3 candles through the 20, 50 or 200 EMA; within 5 candles a close back under that EMA or giving back half the spike; mean volume per spike candle below that of the prior 3-ATR down leg (zero-volume candles ignored). Direction: down. ${OUTCOME}`,
    detect: detectSpikes, match: (e) => e.kind === 'spike_rejected', dir: () => -1,
  },
];

/** null when the outcome cannot be scored yet (not enough candles after the event). */
export function followThrough(c: Candle[], atrs: Array<number | null>, idx: number, dir: 1 | -1, horizon = BASE_RATE_HORIZON): boolean | null {
  const a = atrs[idx];
  if (a == null || a <= 0) return null;
  const p = c[idx]!.c;
  for (let j = idx + 1; j <= idx + horizon; j++) {
    const k = c[j];
    if (!k) return null;
    const target = dir === 1 ? k.h >= p + a : k.l <= p - a;
    const stop = dir === 1 ? k.l <= p - a : k.h >= p + a;
    if (stop) return false;
    if (target) return true;
  }
  return dir * (c[idx + horizon]!.c - p) > 0;
}

/**
 * Base rates per timeframe supplied (15m and 1h are the intended ones), over the last 90 days before `now`
 * or whatever shorter span the candles cover. `windowDays` is the span actually measured.
 */
export function computeBaseRates(candlesByTf: Partial<Record<Timeframe, Candle[]>>, now: number, windowDays = BASE_RATE_WINDOW_DAYS): BaseRate[] {
  const out: BaseRate[] = [];
  for (const tf of ['15m', '1h'] as const) {
    const all = closedCandles(candlesByTf[tf] ?? [], now);
    if (all.length < 2) continue;
    const from = now - windowDays * DAY;
    // Keep 300 candles ahead of the window so the 200 EMA and ATR are warm at its first candle.
    let first = all.findIndex((k) => k.t >= from);
    if (first < 0) first = all.length;
    const start = Math.max(0, first - 300);
    const c = all.slice(start);
    const scanFrom = first - start;
    if (scanFrom >= c.length) continue;
    const ctx: TfContext = { ...buildContext(all[0]!.symbol, tf, c, c.length), scanFrom };
    const at = new Map<number, number>();
    c.forEach((k, i) => at.set(k.t, i));
    const span = Math.max(1, Math.round((now - c[scanFrom]!.t) / DAY));
    for (const spec of BASE_RATE_PATTERNS) {
      let n = 0, hits = 0;
      for (const e of spec.detect(ctx)) {
        if (!spec.match(e)) continue;
        const idx = at.get(e.data.candleT as number);
        if (idx === undefined || idx < scanFrom) continue;
        const r = followThrough(c, ctx.atr, idx, spec.dir(e));
        if (r == null) continue;
        n++;
        if (r) hits++;
      }
      out.push({ pattern: spec.pattern, instrument: ctx.instrument, tf, windowDays: span, n, hitRate: n ? Math.round((hits / n) * 1000) / 1000 : 0, definition: spec.definition, asOf: iso(now) });
    }
  }
  return out;
}

/** "first-touch rejection of a declining 200 EMA: 43% in the last 68 days (n=14)" or "...: n too small (n=4, 68 days)". */
export function baseRateText(r: BaseRate): string {
  const label = BASE_RATE_PATTERNS.find((p) => p.pattern === r.pattern)?.label ?? r.pattern;
  return r.n < BASE_RATE_MIN_N ? `${label}: n too small (n=${r.n}, ${r.windowDays} days)` : `${label}: ${Math.round(r.hitRate * 100)}% in the last ${r.windowDays} days (n=${r.n})`;
}

/** Appends the measured base rate to the text of each pattern event that has one for its instrument and timeframe. */
export function annotateWithBaseRates(events: StructureEvent[], rates: BaseRate[]): StructureEvent[] {
  return events.map((e) => {
    const spec = BASE_RATE_PATTERNS.find((p) => p.match(e));
    const r = spec && rates.find((x) => x.pattern === spec.pattern && x.instrument === e.instrument && x.tf === e.tf);
    if (!r) return e;
    const line = baseRateText(r);
    return { ...e, text: `${e.text} Base rate, ${line[0]!.toLowerCase()}${line.slice(1)}.`, data: { ...e.data, baseRate: { pattern: r.pattern, n: r.n, hitRate: r.hitRate, windowDays: r.windowDays, asOf: r.asOf, text: line } } };
  });
}

