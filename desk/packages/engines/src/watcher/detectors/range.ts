/** Range and compression: inside bars, pennants, opening-range state, last-hour compression against the session midpoint. */
import type { StructureEvent } from '@desk/contracts';
import { sessionBounds } from '../candles';
import { PARAMS, etLabel, mkEvent, px, when, type TfContext } from '../core';

const OR_MINUTES = 30;
const INTRADAY = new Set(['1m', '5m', '15m']);

function insideBars(ctx: TfContext): StructureEvent[] {
  const out: StructureEvent[] = [];
  const { c, n } = ctx;
  let mother = -1;
  for (let i = 1; i < n; i++) {
    const m = mother >= 0 ? mother : i - 1;
    if (c[i]!.h <= c[m]!.h && c[i]!.l >= c[m]!.l) {
      mother = m;
      if (i < ctx.scanFrom) continue;
      const count = i - m;
      out.push(mkEvent(ctx, 'range_compression', i, {
        kind: 'inside_bar', level: c[m]!.l, levelHi: c[m]!.h, bias: 0, confidence: Math.min(0.6, 0.35 + 0.05 * count), anchor: [c[m]!.t, count],
        obsKey: `inside|${ctx.tf}|${c[m]!.t}`, severity: count,
        text: `${ctx.instrument} ${ctx.tf} ${count} inside bar${count > 1 ? 's' : ''} within the ${when(ctx.tf, c[m]!.t, c[i]!.t)} ET candle ${px(c[m]!.l)}-${px(c[m]!.h)}. Compression; direction undecided.`,
        short: `${ctx.tf} ${count} inside bar${count > 1 ? 's' : ''} in ${px(c[m]!.l)}-${px(c[m]!.h)}`,
        data: { count, motherT: c[m]!.t },
      }));
    } else mother = -1;
  }
  return out;
}

const slope = (ys: number[]): number => {
  const n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  return num / den;
};

/** Pennant: over 12 candles highs fall, lows rise, and the last third's range is at most half the first third's (which spans at least 2 ATR). */
function pennant(ctx: TfContext): StructureEvent[] {
  const W = PARAMS.pennantWindow, { c, n } = ctx;
  if (n < W + 1) return [];
  const w = c.slice(n - W), third = W / 3;
  const a = ctx.atr[n - W - 1];
  const range = (xs: typeof w): number => Math.max(...xs.map((k) => k.h)) - Math.min(...xs.map((k) => k.l));
  const first = range(w.slice(0, third)), lastR = range(w.slice(W - third));
  if (a == null || first < 2 * a || lastR > 0.5 * first) return [];
  if (!(slope(w.map((k) => k.h)) < 0 && slope(w.map((k) => k.l)) > 0)) return [];
  const hi = w.reduce((m, k) => (k.h > m.h ? k : m)), lo = w.reduce((m, k) => (k.l < m.l ? k : m));
  const tail = w.slice(W - third);
  const tHi = Math.max(...tail.map((k) => k.h)), tLo = Math.min(...tail.map((k) => k.l));
  return [mkEvent(ctx, 'range_compression', n - 1, {
    kind: 'pennant', level: tLo, levelHi: tHi, bias: 0, confidence: 0.5, anchor: [hi.t, lo.t],
    text: `${ctx.instrument} ${ctx.tf} pennant: range ${px(first)} pts down to ${px(lastR)} over ${W} candles, lower highs from ${px(hi.h)}, higher lows from ${px(lo.l)}. Coiled between ${px(tLo)} and ${px(tHi)}.`,
    short: `${ctx.tf} pennant ${px(tLo)}-${px(tHi)}`,
    data: { windowCandles: W, firstRange: first, lastRange: lastR, high: hi.h, low: lo.l },
  })];
}

/** Opening range = first 30 minutes of the cash session (09:30-10:00 ET). Each state change after it sets is one event. */
function openingRange(ctx: TfContext): StructureEvent[] {
  const { c, n } = ctx;
  if (!n || !INTRADAY.has(ctx.tf)) return [];
  const day = etLabel(c[n - 1]!.t).day;
  const { from, to } = sessionBounds(day, 'cash');
  const orEnd = from + OR_MINUTES * 60_000;
  let hi = -Infinity, lo = Infinity, first = -1;
  for (let i = Math.max(0, n - 1000); i < n; i++) {
    const k = c[i]!;
    if (k.t < from) continue;
    if (k.t + ctx.tfMs <= orEnd) { hi = Math.max(hi, k.h); lo = Math.min(lo, k.l); } else { first = i; break; }
  }
  if (first < 0 || hi === -Infinity) return [];
  const out: StructureEvent[] = [];
  const emit = (i: number, kind: string, bias: -1 | 0 | 1, confidence: number, tail: string): void => {
    if (i < ctx.scanFrom) return;
    out.push(mkEvent(ctx, 'range_compression', i, {
      kind, level: lo, levelHi: hi, bias, confidence, anchor: [day, c[i]!.t], obsKey: `opening_range|${ctx.tf}|${day}|${kind}|${c[i]!.t}`,
      text: `${ctx.instrument} ${ctx.tf} opening range ${px(lo)}-${px(hi)} (${px(hi - lo)} pts): close ${px(c[i]!.c)} at ${when(ctx.tf, c[i]!.t, c[i]!.t)} ET. ${tail}`,
      short: `${tail.replace(/\.$/, '').toLowerCase()} (${px(lo)}-${px(hi)})`,
      data: { orHigh: hi, orLow: lo, day, close: c[i]!.c },
    }));
  };
  let state: 'inside' | 'above' | 'below' = 'inside';
  if (first - 1 >= 0) emit(first - 1, 'or_set', 0, 0.4, 'Opening range set.');
  for (let i = first; i < n && c[i]!.t < to; i++) {
    const next = c[i]!.c > hi ? 'above' : c[i]!.c < lo ? 'below' : 'inside';
    if (next === state) continue;
    if (next === 'above') emit(i, 'or_break_up', 1, 0.55, 'Opening range broken up.');
    else if (next === 'below') emit(i, 'or_break_down', -1, 0.55, 'Opening range broken down.');
    else emit(i, state === 'above' ? 'or_failed_break_up' : 'or_failed_break_down', state === 'above' ? -1 : 1, 0.55, `Back inside the opening range: ${state === 'above' ? 'upside' : 'downside'} break failed.`);
    state = next;
  }
  return out;
}

/**
 * Last-hour compression: from 15:30 ET, the range since 15:00 is at most a third of the 09:30-15:00 range
 * and every close since 15:00 sits on one side of the session midpoint.
 */
function lastHour(ctx: TfContext): StructureEvent[] {
  const { c, n } = ctx;
  if (!n || !INTRADAY.has(ctx.tf)) return [];
  const lastClose = c[n - 1]!.t + ctx.tfMs;
  const day = etLabel(c[n - 1]!.t).day;
  const { from, to } = sessionBounds(day, 'cash');
  const hourStart = to - 3_600_000;
  if (lastClose < hourStart + 1_800_000 || lastClose > to) return [];
  let sh = -Infinity, sl = Infinity, lh = -Infinity, ll = Infinity, under = true, over = true, k = 0;
  for (let i = Math.max(0, n - 1000); i < n; i++) {
    const x = c[i]!;
    if (x.t < from) continue;
    if (x.t < hourStart) { sh = Math.max(sh, x.h); sl = Math.min(sl, x.l); }
    else { lh = Math.max(lh, x.h); ll = Math.min(ll, x.l); k++; }
  }
  if (sh === -Infinity || !k) return [];
  const mid = (sh + sl) / 2;
  for (let i = n - k; i < n; i++) { if (c[i]!.c >= mid) under = false; if (c[i]!.c <= mid) over = false; }
  const ratio = (lh - ll) / (sh - sl);
  if (!(ratio <= PARAMS.lastHourCompression) || (!under && !over)) return [];
  return [mkEvent(ctx, 'range_compression', n - 1, {
    kind: under ? 'last_hour_compression_under_mid' : 'last_hour_compression_over_mid', level: ll, levelHi: lh, bias: under ? -1 : 1, confidence: 0.6,
    anchor: [day], obsKey: `last_hour|${ctx.tf}|${day}`,
    text: `${ctx.instrument} ${ctx.tf} last hour ${px(ll)}-${px(lh)}: ${px(lh - ll)} pts, ${Math.round(ratio * 100)}% of the session range ${px(sl)}-${px(sh)}, every close ${under ? 'under' : 'over'} the midpoint ${px(mid)}. Compression ${under ? 'under' : 'over'} the midpoint.`,
    short: `last hour compressed to ${px(lh - ll)} pts ${under ? 'under' : 'over'} the midpoint ${px(mid)}`,
    data: { sessionHigh: sh, sessionLow: sl, midpoint: mid, lastHourHigh: lh, lastHourLow: ll, rangePctOfSession: ratio * 100, day },
  })];
}

export function detectRange(ctx: TfContext): StructureEvent[] {
  return [...insideBars(ctx), ...pennant(ctx), ...openingRange(ctx), ...lastHour(ctx)];
}
