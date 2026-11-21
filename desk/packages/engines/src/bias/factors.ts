/** Stage 2a: the ten factor scorers. Each reads BiasInputs and returns -2..+2 with a numbers-first evidence line. */
import { DAY, HOUR, ageLabel, clamp, fmtNum, round, type FactorName, type Horizon } from '@desk/contracts';
import { WEEKDAY, etStamp, horizonEnd } from './calendar';
import { branchDir } from './extract';
import type { BiasInputs, CatalystIn, RawFactor, StructureIn, YieldIn } from './types';

export const sg = (x: number, dp = 1): string => { const a = Math.abs(x).toFixed(dp); return `${x >= 0 || Number(a) === 0 ? '+' : '−'}${a}`; };
export const px = (x: number): string => fmtNum(x, Math.abs(x) >= 1000 ? 0 : 2);
const nowMs = (inp: BiasInputs): number => Date.parse(inp.now);
const have = (factor: FactorName, score: number, evidence: string, asOf: string): RawFactor =>
  ({ factor, score: round(clamp(score, -2, 2), 2), evidence, asOf, stale: false, missing: false });
const none = (factor: FactorName, inp: BiasInputs, detail?: string): RawFactor =>
  ({ factor, score: 0, evidence: detail ? `no data: ${detail}` : 'no data', asOf: inp.now, stale: false, missing: true });
const staleOut = (factor: FactorName, inp: BiasInputs, asOf: string, what: string): RawFactor =>
  ({ factor, score: 0, evidence: `stale, not used: ${what} as of ${ageLabel(asOf, nowMs(inp))} ago`, asOf, stale: true, missing: true });
/** Weighted mean over the parts that exist; null when none do. */
function blend(parts: Array<[number | null, number]>): number | null {
  const ok = parts.filter((p): p is [number, number] => p[0] != null && p[1] > 0);
  const w = ok.reduce((a, p) => a + p[1], 0);
  return w > 0 ? ok.reduce((a, p) => a + p[0] * p[1], 0) / w : null;
}
/** sqrt-of-time scale for move thresholds across horizons. */
const SCALE: Record<Horizon, number> = { intraday: 1, swing: 1.7, position: 3 };

/* ───────── 1. rates impulse ───────── */

const RATE_LOOKS = {
  intraday: { s: 'chg1hBp', l: 'chg1dBp', sBp: 4, lBp: 8, sName: '1h', lName: '1d', si: 'chg1hPct', li: 'chg1dPct' },
  swing: { s: 'chg1dBp', l: 'chg5dBp', sBp: 8, lBp: 15, sName: '1d', lName: '5d', si: 'chg1dPct', li: 'chg5dPct' },
  position: { s: 'chg5dBp', l: 'chg20dBp', sBp: 15, lBp: 30, sName: '5d', lName: '20d', si: 'chg5dPct', li: 'chg20dPct' },
} as const;
/** Round yield levels sit on a 0.25% grid (4.75, 5.00, ...). */
const ROUND_STEP = 0.25;

/**
 * Yields up = negative. Short lookback 60%, long 40% (1h/1d intraday, 1d/5d swing, 5d/20d position); 10Y 60%, 2Y 40%.
 * +0.5 when yields fall with the instrument rising, -0.5 for the reverse; halved when yields fall with the
 * instrument down 1%+ (haven bid, not a tailwind). -0.75 for a break up through a round level, +0.5 for a
 * break down, -0.25 when rising inside 5 bp under one.
 */
export function scoreRates(inp: BiasInputs): RawFactor {
  const { y10, y2, idx } = inp.rates, L = RATE_LOOKS[inp.horizon];
  const live = (y: YieldIn | null): YieldIn | null => (y && !y.stale ? y : null);
  const a = live(y10), b = live(y2), lead = a ?? b;
  if (!lead) {
    const old = y10 ?? y2;
    return old ? staleOut('rates', inp, old.asOf, `${y10 ? '10Y' : '2Y'} ${old.level.toFixed(2)}%`) : none('rates', inp);
  }
  const impulse = (y: YieldIn | null): number | null => (y ? blend([[y[L.s] == null ? null : y[L.s]! / L.sBp, 0.6], [y[L.l] == null ? null : y[L.l]! / L.lBp, 0.4]]) : null);
  const x = blend([[impulse(a), 0.6], [impulse(b), 0.4]]);
  const name = a ? '10Y' : '2Y';
  if (x == null) return none('rates', inp, `${name} ${lead.level.toFixed(2)}%, no earlier reading to measure a change`);
  let score = -clamp(x, -1.5, 1.5);
  const notes: string[] = [];
  const yS = lead[L.s] ?? lead[L.l], iS = idx[L.si] ?? idx[L.li];
  if (yS != null && iS != null && Math.abs(yS) >= 1 && Math.abs(iS) >= 0.1) {
    if (yS < 0 && iS > 0) { score += 0.5; notes.push(`${inp.instrument} ${sg(iS)}% with yields falling`); }
    else if (yS > 0 && iS < 0) { score -= 0.5; notes.push(`${inp.instrument} ${sg(iS)}% with yields rising`); }
    else if (yS < 0 && iS <= -1) { score *= 0.5; notes.push(`${inp.instrument} ${sg(iS)}%: haven bid, not a tailwind`); }
  }
  if (a && yS != null) {
    const level = a.level, prev = level - yS / 100, grid = Math.round(level / ROUND_STEP) * ROUND_STEP;
    if (prev < grid && level >= grid) { score -= 0.75; notes.push(`up through ${grid.toFixed(2)}%`); }
    else if (prev > grid && level <= grid) { score += 0.5; notes.push(`down through ${grid.toFixed(2)}%`); }
    else {
      const above = Math.ceil(level / ROUND_STEP) * ROUND_STEP, gap = (above - level) * 100;
      if (yS > 0 && gap > 0 && gap <= 5) { score -= 0.25; notes.push(`${gap.toFixed(0)} bp under ${above.toFixed(2)}%`); }
    }
  }
  const chg = (y: YieldIn, n: string): string => {
    const s = y[L.s], l = y[L.l];
    return `${n} ${s != null ? `${sg(s)} bp ${L.sName}` : ''}${s != null && l != null ? ', ' : ''}${l != null ? `${sg(l)} bp ${L.lName}` : ''} to ${y.level.toFixed(2)}%`;
  };
  const ev = [a ? chg(a, '10Y') : null, b ? chg(b, '2Y') : null, ...notes].filter(Boolean).join('; ');
  return have('rates', score, ev, lead.asOf);
}

/* ───────── 2. Fed pricing ───────── */

/** (change in cut odds - change in hike odds) / 10 points; 1d lookback, 5d for position. Falls back to the implied rate, 5 bp = 1. */
export function scoreFed(inp: BiasInputs): RawFactor {
  const f = inp.fed;
  if (f.stale && f.asOf) return staleOut('fed', inp, f.asOf, 'Fed odds');
  if (!f.asOf) return none('fed', inp);
  const long = inp.horizon === 'position';
  const dH = long ? f.dHike5d ?? f.dHike1d : f.dHike1d ?? f.dHike5d;
  const dC = long ? f.dCut5d ?? f.dCut1d : f.dCut1d ?? f.dCut5d;
  const dI = long ? f.dImplied5dBp ?? f.dImplied1dBp : f.dImplied1dBp ?? f.dImplied5dBp;
  const span = long ? '5d' : '1d';
  const pts = (x: number): string => `${sg(x * 100, 0)} pts`;
  if (dH != null || dC != null) {
    const ev = [
      dH != null && f.hike != null ? `Hike odds ${pts(dH)} to ${(f.hike * 100).toFixed(0)}% in ${span}` : null,
      dC != null && f.cut != null ? `cut odds ${pts(dC)} to ${(f.cut * 100).toFixed(0)}%` : null,
    ].filter(Boolean).join('; ');
    return have('fed', ((dC ?? 0) - (dH ?? 0)) / 0.1, ev, f.asOf);
  }
  if (dI != null && f.impliedRate != null) return have('fed', -dI / 5, `Implied rate ${sg(dI)} bp to ${f.impliedRate.toFixed(2)}% in ${span}`, f.asOf);
  return none('fed', inp, 'Fed odds have no earlier reading to measure a change');
}

/* ───────── 3. catalyst state ───────── */

const RESOLVED_WINDOW: Record<Horizon, number> = { intraday: 8 * HOUR, swing: 2 * DAY, position: 5 * DAY };
export interface CatalystState {
  /** Resolved inside the horizon's window with a matched branch; the most recent, Tier 1 first. */
  resolved: CatalystIn | null;
  /** True while `resolved` is inside its 2-hour dominance window. */
  within2h: boolean;
  live: CatalystIn | null;
  /** Nearest upcoming inside the horizon (Tier 1 or 2). */
  upcoming: CatalystIn | null;
  /** Nearest upcoming at any distance, and the nearest Tier 1. */
  next: CatalystIn | null; nextTier1: CatalystIn | null;
  /** A Tier 1/2 catalyst is live, upcoming inside the horizon, or resolved inside the window. */
  inPlay: boolean;
}
export function catalystState(inp: BiasInputs): CatalystState {
  const now = nowMs(inp), end = horizonEnd(now, inp.horizon);
  const planned = inp.catalysts.filter((c) => c.tier <= 2);
  const resolvedAll = planned.filter((c) => c.status === 'resolved' && c.branch && now - Date.parse(c.resolvedAt!) <= RESOLVED_WINDOW[inp.horizon]);
  const newest = (xs: CatalystIn[]): CatalystIn | null => xs.reduce<CatalystIn | null>((a, c) => (!a || c.resolvedAt! > a.resolvedAt! ? c : a), null);
  const resolved = newest(resolvedAll.filter((c) => c.tier === 1)) ?? newest(resolvedAll);
  const upcomingAll = inp.catalysts.filter((c) => c.status === 'upcoming').sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const live = planned.find((c) => c.status === 'live') ?? null;
  const upcoming = upcomingAll.find((c) => c.tier <= 2 && Date.parse(c.scheduledAt) <= end) ?? null;
  return {
    resolved, within2h: !!resolved && now - Date.parse(resolved.resolvedAt!) <= 2 * HOUR, live, upcoming,
    next: upcomingAll.find((c) => c.tier <= 2) ?? upcomingAll[0] ?? null, nextTier1: upcomingAll.find((c) => c.tier === 1) ?? null,
    inPlay: !!resolved || !!live || !!upcoming,
  };
}
const fmtVal = (v: number | null, unit: string | null): string => (v == null ? 'n/a' : `${v}${unit ?? ''}`);

/**
 * Resolved with a matched branch: direction of the branch, magnitude (1 + read/implied move, capped at 2) x
 * (1 + half the branch's surprise, 1 - p). Full for 2 hours, then linear to zero at the end of the window
 * (8h intraday, 2d swing, 5d position). Halved when the 15-minute reaction or, after 15 minutes, the 10Y goes
 * the other way. Upcoming with a matrix: the probability-weighted skew, capped at 1 (0.6 for Tier 2). Live: 0.
 */
export function scoreCatalyst(inp: BiasInputs): RawFactor {
  const st = catalystState(inp), now = nowMs(inp);
  const c = st.resolved;
  if (c?.branch && c.resolvedAt) {
    const b = c.branch, dir = branchDir(b, inp.horizon);
    const mins = (now - Date.parse(c.resolvedAt)) / 60_000;
    const head = `${c.name} ${fmtVal(c.actual, c.unit)} vs ${fmtVal(c.consensus, c.unit)} consensus, ${mins < 90 ? `${mins.toFixed(0)} min` : `${(mins / 60).toFixed(1)}h`} ago: branch "${b.label}" (p ${b.probability.toFixed(2)})`;
    if (dir === 0) return have('catalyst', 0, `${head} says stand aside${b.noTradeReason ? `: ${b.noTradeReason}` : ''}`, c.resolvedAt);
    const read = inp.horizon === 'intraday' ? b.h1Pct : b.closePct;
    const age = now - Date.parse(c.resolvedAt), win = RESOLVED_WINDOW[inp.horizon];
    let mag = Math.min(2, (1 + Math.min(1, Math.abs(read) / (c.impliedMovePct && c.impliedMovePct > 0 ? c.impliedMovePct : 1))) * (1 + 0.5 * (1 - b.probability)));
    mag *= age <= 2 * HOUR ? 1 : Math.max(0, 1 - (age - 2 * HOUR) / (win - 2 * HOUR));
    const notes: string[] = [];
    if (c.reactionM15Pct != null && Math.abs(c.reactionM15Pct) >= 0.1 && Math.sign(c.reactionM15Pct) === -dir) { mag *= 0.5; notes.push(`15m reaction ${sg(c.reactionM15Pct, 2)}% the other way`); }
    const fm = inp.firstMove;
    if (fm && fm.catalystId === c.id && fm.minutesSince > 15 && fm.y10SinceBp != null && b.y10Bp !== 0 && Math.abs(fm.y10SinceBp) >= 1 && Math.sign(fm.y10SinceBp) === -Math.sign(b.y10Bp)) {
      mag *= 0.5; notes.push(`10Y ${sg(fm.y10SinceBp)} bp since, not confirming`);
    }
    const ev = `${head} reads ${inp.instrument} ${sg(read, 2)}% ${inp.horizon === 'intraday' ? '1h' : 'to the close'}, 10Y ${sg(b.y10Bp, 0)} bp${notes.length ? `; ${notes.join('; ')}` : ''}`;
    return have('catalyst', dir * mag, ev, c.resolvedAt);
  }
  if (st.live) return have('catalyst', 0, `${st.live.name} out ${etStamp(st.live.scheduledAt)}, print not matched to a branch yet`, st.live.asOf);
  const u = st.upcoming;
  if (u?.expected) {
    const hrs = (Date.parse(u.scheduledAt) - now) / HOUR;
    return have('catalyst', clamp(u.expected.skew, -1, 1) * (u.tier === 1 ? 1 : 0.6),
      `${u.name} ${etStamp(u.scheduledAt)}, in ${hrs.toFixed(1)}h: branch-weighted close read ${sg(u.expected.closePct, 2)}%, skew ${sg(u.expected.skew, 2)}`, u.asOf);
  }
  if (u) return none('catalyst', inp, `${u.name} ${etStamp(u.scheduledAt)} has no scenario matrix yet`);
  return none('catalyst', inp, 'no catalyst inside the horizon');
}

/* ───────── 4. regime ───────── */

const REGIME_MIX: Record<Horizon, [number, number, number, number]> = { intraday: [0.2, 0.15, 0.45, 0.2], swing: [0.35, 0.3, 0.15, 0.2], position: [0.45, 0.35, 0, 0.2] };
const posture = (close: number, e50: number | null, e200: number | null): number | null =>
  (e50 == null ? null : e200 == null ? 0.5 * Math.sign(close - e50) : 0.5 * Math.sign(close - e50) + 0.5 * Math.sign(close - e200));

/**
 * Four parts in -1..1, mixed by horizon [daily EMA posture, 20-day trend, 15m EMA posture, correction depth]:
 * intraday .20/.15/.45/.20, swing .35/.30/.15/.20, position .45/.35/0/.20, times 2.
 * Posture = half for the side of the 50 EMA, half for the 200. Trend = 20-day return / 6%. Depth = 0 inside 3%
 * of the 252-bar high, -1 at 10% off. Below a falling 200 EMA the posture is -1 and the score cannot exceed -1.
 */
export function scoreRegime(inp: BiasInputs): RawFactor {
  const g = inp.regime;
  if (g.stale && g.asOf) return staleOut('regime', inp, g.asOf, `${inp.instrument} candles`);
  if (!g.asOf || (!g.d1 && !g.m15)) return none('regime', inp);
  const d = g.d1, m = g.m15, notes: string[] = [];
  let a: number | null = null, b: number | null = null, c: number | null = null, dep: number | null = null, sold = false;
  if (d) {
    a = posture(d.close, d.ema50, d.ema200);
    if (d.ema200 != null && d.ema200SlopePct != null && d.close < d.ema200 && d.ema200SlopePct < 0) { a = -1; sold = true; }
    b = d.ret20Pct == null ? null : clamp(d.ret20Pct / 6, -1, 1);
    dep = d.depthPct >= -3 ? 0 : -clamp((-d.depthPct - 3) / 7, 0, 1);
    notes.push(`${px(d.close)}: ${sg(d.depthPct)}% from the ${px(d.high)} high${d.ret5Pct != null ? `, ${sg(d.ret5Pct)}% in 5d` : ''}${d.ret20Pct != null ? `, ${sg(d.ret20Pct)}% in 20d` : ''}`);
    const side = (e: number | null, n: string): string | null => (e == null ? null : `${d.close >= e ? 'above' : 'below'} the daily ${n} EMA ${px(e)}`);
    notes.push([side(d.ema50, '50'), side(d.ema200, '200')].filter(Boolean).join(', ') + (sold ? ' and it is falling: bounces are sold' : ''));
  }
  if (m) {
    c = posture(m.close, m.ema50, m.ema200);
    const falling = m.ema200 != null && m.ema200SlopePct != null && m.close < m.ema200 && m.ema200SlopePct < 0;
    if (falling) c = -1;
    if (m.ema50 != null) notes.push(`15m ${m.close >= m.ema50 ? 'above' : 'below'} the 50 EMA ${px(m.ema50)}${m.ema200 != null ? `, ${m.close >= m.ema200 ? 'above' : 'below'} the ${falling ? 'falling ' : ''}200 at ${px(m.ema200)}` : ''}`);
  }
  const w = REGIME_MIX[inp.horizon];
  const mix = blend([[a, w[0]], [b, w[1]], [c, w[2]], [dep, w[3]]]);
  if (mix == null) return none('regime', inp, 'too few candles for the EMAs');
  return have('regime', sold ? Math.min(-1, 2 * mix) : 2 * mix, notes.filter(Boolean).join('; '), g.asOf);
}

/* ───────── 5. breadth and leadership ───────── */

/**
 * Relative returns over 1 / 3 / 10 daily bars (intraday / swing / position), thresholds scaled by sqrt-time:
 * chips vs index (SOX - QQQ, 1.5% = 1) 45%, defensives vs index (mean XLP, XLU - QQQ, 1.5% = -1) 35%,
 * equal-weight vs cap-weight (RSP - ES, 1% = 1) 20%, times 2. Advance/decline is shown, not scored (no common scale).
 */
export function scoreBreadth(inp: BiasInputs): RawFactor {
  const b = inp.breadth, k = SCALE[inp.horizon];
  const rel = (x: number | null, y: number | null): number | null => (x == null || y == null ? null : x - y);
  const def = b.xlp != null && b.xlu != null ? (b.xlp + b.xlu) / 2 : b.xlp ?? b.xlu;
  const chips = rel(b.sox, b.index), defRel = rel(def, b.index), eqw = rel(b.rsp, b.es);
  const mix = blend([
    [chips == null ? null : clamp(chips / (1.5 * k), -1, 1), 0.45],
    [defRel == null ? null : -clamp(defRel / (1.5 * k), -1, 1), 0.35],
    [eqw == null ? null : clamp(eqw / k, -1, 1), 0.2],
  ]);
  if (mix == null || !b.asOf) {
    return b.stale ? { ...none('breadth', inp), evidence: `stale, not used: ${b.staleSymbols.join(', ')} candles`, stale: true } : none('breadth', inp);
  }
  const span = `${b.lookbackBars}d`;
  const ev = [
    chips != null ? `SOX ${sg(b.sox!)}% vs ${b.indexSymbol} ${sg(b.index!)}% ${span}` : null,
    defRel != null ? `${b.xlp != null ? `staples ${sg(b.xlp)}%` : ''}${b.xlp != null && b.xlu != null ? ', ' : ''}${b.xlu != null ? `utilities ${sg(b.xlu)}%` : ''}${chips == null ? ` vs ${b.indexSymbol} ${sg(b.index!)}% ${span}` : ''}` : null,
    eqw != null ? `RSP ${sg(b.rsp!)}% vs ES ${sg(b.es!)}%` : null,
    b.adLine ? `A/D ${sg(b.adLine.value, 0)} (shown, not scored)` : null,
  ].filter(Boolean).join('; ');
  return have('breadth', 2 * mix, ev, b.asOf);
}

/* ***** 6. positioning ***** */

/**
 * Crowding in -1..1 (+ = crowded long) is the mean of what exists: VIX percentile of its own 252 daily closes
 * (only beyond the 20th/80th percentile; high VIX = hedged = crowded short), VIX term structure (VIX3M/VIX under 1,
 * 0.90 = -1), CFTC net spec z-score / 2, put/call and skew z-scores / -2 (z needs 20 readings).
 * Score = -2 x crowding: fade the crowd. Full weight in the 24h after a resolved catalyst, half otherwise.
 */
export function scorePositioning(inp: BiasInputs): RawFactor {
  const p = inp.positioning;
  const parts: number[] = [], ev: string[] = [];
  if (p.vix) {
    if (p.vix.pctile1y != null) {
      const x = (0.5 - p.vix.pctile1y) * 2;
      parts.push(Math.abs(x) < 0.6 ? 0 : Math.sign(x) * (Math.abs(x) - 0.6) / 0.4);
      ev.push(`VIX ${p.vix.level.toFixed(1)}, ${(p.vix.pctile1y * 100).toFixed(0)}th pct of 1y`);
    } else ev.push(`VIX ${p.vix.level.toFixed(1)}`);
  }
  if (p.term) { parts.push(-clamp((1 - p.term.value) / 0.1, 0, 1)); ev.push(`term ${p.term.value.toFixed(2)}${p.term.value < 1 ? ' backwardated' : ''}`); }
  if (p.cftc) { if (p.cftc.z != null) parts.push(clamp(p.cftc.z / 2, -1, 1)); ev.push(`CFTC net ${sg(p.cftc.value, 0)}${p.cftc.z != null ? ` (z ${sg(p.cftc.z)})` : ''}`); }
  if (p.putCall) { if (p.putCall.z != null) parts.push(-clamp(p.putCall.z / 2, -1, 1)); ev.push(`put/call ${p.putCall.value.toFixed(2)}${p.putCall.z != null ? ` (z ${sg(p.putCall.z)})` : ''}`); }
  if (p.skew) { if (p.skew.z != null) parts.push(-clamp(p.skew.z / 2, -1, 1)); ev.push(`skew ${p.skew.value.toFixed(1)}${p.skew.z != null ? ` (z ${sg(p.skew.z)})` : ''}`); }
  if (p.impliedMovePct != null) ev.push(`implied move ${p.impliedMovePct.toFixed(1)}%`);
  if (parts.length === 0 || !p.asOf) {
    if (p.stale) return { ...none('positioning', inp), evidence: `stale, not used: ${p.staleKeys.join(', ')}`, stale: true };
    return none('positioning', inp, ev.length ? `${ev.join(', ')}: no baseline to call it crowded` : undefined);
  }
  const crowd = parts.reduce((a, x) => a + x, 0) / parts.length;
  const read = Math.abs(crowd) < 0.2 ? 'not crowded' : `crowded ${crowd > 0 ? 'long' : 'short'}, ${p.postCatalyst ? 'fade it after the print' : 'half weight until a print'}`;
  return have('positioning', -2 * crowd * (p.postCatalyst ? 1 : 0.5), `${ev.join(', ')}: ${read}`, p.asOf);
}

/* ───────── 7. news flow ───────── */

/** Net of impact x direction over 24h, / 4 (intraday: headlines older than 6h count half). Three impact-3 one way pins it at 1.5 or beyond. */
export function scoreNews(inp: BiasInputs): RawFactor {
  const items = inp.news.items, now = nowMs(inp);
  if (items.length === 0 || !inp.news.asOf) return none('news', inp, 'no impact-scored headlines in 24h');
  const net = items.reduce((a, h) => a + h.impact * h.direction * (inp.horizon === 'intraday' && now - Date.parse(h.ts) > 6 * HOUR ? 0.5 : 1), 0);
  const neg3 = items.filter((h) => h.impact === 3 && h.direction === -1).length, pos3 = items.filter((h) => h.impact === 3 && h.direction === 1).length;
  let score = net / 4;
  if (neg3 >= 3) score = Math.min(score, -1.5);
  if (pos3 >= 3) score = Math.max(score, 1.5);
  const top = items.find((h) => h.direction !== 0) ?? items[0]!;
  const lead = neg3 >= 3 ? `${neg3} negative impact-3 headlines in 24h, ` : pos3 >= 3 ? `${pos3} positive impact-3 headlines in 24h, ` : '';
  return have('news', score, `${lead}net ${sg(net)} over ${items.length} headline${items.length === 1 ? '' : 's'}; top: "${top.title}" (impact ${top.impact})`, inp.news.asOf);
}

/* ───────── 8. structure ───────── */

const STRUCT_WINDOW: Record<Horizon, number> = { intraday: 8 * HOUR, swing: 2 * DAY, position: 5 * DAY };
const DETECTOR_W: Record<string, number> = { mss: 1, sweep_reclaim: 1, retrace_quality: 1, bos: 0.8, ema_posture: 0.6, divergence: 0.5, volume_context: 0.5, range_compression: 0.4, order_block: 0.3, fvg: 0.3 };
const TF_W: Record<Horizon, Record<string, number>> = {
  intraday: { '1m': 0.4, '5m': 0.6, '15m': 1, '1h': 1, '1d': 0.5 },
  swing: { '1m': 0.1, '5m': 0.2, '15m': 0.5, '1h': 1, '1d': 1 },
  position: { '1m': 0, '5m': 0.1, '15m': 0.2, '1h': 0.6, '1d': 1 },
};
const SIGNAL_DETECTORS = new Set(['mss', 'bos', 'sweep_reclaim', 'retrace_quality', 'ema_posture']);
const inWindow = (inp: BiasInputs, e: StructureIn): boolean => nowMs(inp) - Date.parse(e.ts) <= STRUCT_WINDOW[inp.horizon];
/** Directional watcher events that count as a structure signal for the no-edge gate. */
export function structureSignals(inp: BiasInputs): StructureIn[] {
  return inp.structure.filter((e) => e.bias !== 0 && inWindow(inp, e) && (e.confirmedSetup || (SIGNAL_DETECTORS.has(e.detector) && e.confidence >= 0.5)) && (TF_W[inp.horizon][e.tf] ?? 0) >= 0.5);
}
/** Nearest known levels on each side of the price (swings, liquidity pools, FVG/OB/MSS levels), nearest first. */
export function levelsAround(inp: BiasInputs): { above: number[]; below: number[] } {
  const price = inp.levels.price, set = new Set<number>();
  for (const e of inp.structure) {
    if (e.detector === 'ema_posture' || e.detector === 'divergence' || e.detector === 'volume_context') continue;
    for (const l of [e.level, e.levelHi]) if (l != null && Number.isFinite(l)) set.add(l);
  }
  const all = [...set];
  return { above: all.filter((l) => l > price).sort((x, y) => x - y), below: all.filter((l) => l < price).sort((x, y) => y - x) };
}
/**
 * Sum over the latest event of each (detector, kind, timeframe) inside the window (8h / 2d / 5d) of
 * bias x confidence x detector weight x timeframe weight x recency (1 falling to 0.5 across the window).
 * A first-touch EMA rejection counts half: it is a known false signal. Liquidity pools are levels, not a direction.
 */
export function scoreStructure(inp: BiasInputs): RawFactor {
  if (inp.structure.length === 0) return none('structure', inp, 'no watcher events');
  const now = nowMs(inp), seen = new Set<string>(), used: Array<{ e: StructureIn; x: number }> = [];
  for (const e of inp.structure) {
    if (e.bias === 0 || !inWindow(inp, e)) continue;
    const key = `${e.detector}|${e.kind}|${e.tf}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const w = (DETECTOR_W[e.detector] ?? 0) * (TF_W[inp.horizon][e.tf] ?? 0) * (e.kind === 'first_touch_rejection' ? 0.5 : 1);
    const x = e.bias * e.confidence * w * (1 - 0.5 * (now - Date.parse(e.ts)) / STRUCT_WINDOW[inp.horizon]);
    if (x !== 0) used.push({ e, x });
  }
  const { above, below } = levelsAround(inp);
  const liq = above.length || below.length ? `levels ${above[0] != null ? `${px(above[0])} above` : 'none above'} / ${below[0] != null ? `${px(below[0])} below` : 'none below'}` : null;
  const asOf = inp.structure[0]!.ts;
  if (used.length === 0) return have('structure', 0, [`No directional signal in the window`, liq].filter(Boolean).join('; '), asOf);
  const net = used.reduce((a, u) => a + u.x, 0);
  const top = used.sort((p, q) => Math.abs(q.x) - Math.abs(p.x))[0]!.e;
  return have('structure', net, [`${top.text} (${top.tf} ${top.kind})`, `${used.length} signal${used.length === 1 ? '' : 's'}, net ${sg(net, 2)}`, liq].filter(Boolean).join('; '), asOf);
}

/* ───────── 9. calendar and seasonality ───────── */

const TAG_NAME: Record<string, string> = { opex_week: 'OpEx week', opex_day: 'OpEx day', month_end: 'month-end', holiday_week: 'holiday week' };
/**
 * Small by design, capped at 0.75. Each tag active today (weekday, OpEx week/day, last two sessions of the
 * month, holiday week) adds clamp(t/2) x 0.25 when the instrument's own daily closes in the snapshot give it
 * 20+ instances and |t| >= 1. Thanksgiving week adds +0.25: that one is the spec's prior, not a measured rate.
 * The Friday before a long weekend is named ("reduce") and carries no direction.
 */
export function scoreCalendar(inp: BiasInputs): RawFactor {
  const c = inp.calendar, ev: string[] = [];
  let score = 0;
  for (const t of c.tags) {
    const name = t.tag.startsWith('dow:') ? WEEKDAY[Number(t.tag.slice(4))]! : TAG_NAME[t.tag] ?? t.tag;
    const counts = t.n >= 20 && Math.abs(t.t) >= 1;
    if (counts) score += clamp(t.t / 2, -1, 1) * 0.25;
    ev.push(`${name} ${sg(t.meanPct, 2)}% avg over ${t.n} (t ${sg(t.t)}${counts ? '' : ', not scored'})`);
  }
  score = clamp(score, -0.5, 0.5);
  if (c.thanksgivingWeek) { score += 0.25; ev.push('Thanksgiving week +0.25 (spec prior)'); }
  if (c.preLongWeekend) ev.push('last session before a long weekend: reduce');
  if (ev.length === 0) ev.push(`${WEEKDAY[c.weekday]} ${c.sessionDay}: no seasonal tag with history`);
  return have('calendar', clamp(score, -0.75, 0.75), `${c.sessionDay} ${ev.join('; ')}`, inp.now);
}

/* ───────── 10. cross-asset ───────── */

/**
 * Over 1 / 3 / 10 daily bars, sqrt-time scaled: dollar (DXY +0.5% = -1) 35%; oil up 2%+ with the 10Y up = -1, 30%;
 * BTC (3% = 1) 25%; gold up 0.5%+ with the dollar up = -0.5 (haven bid) 10%; times 2.
 * 10Y down 8 bp+ with the instrument down 1%+ is reported as the regime-change flag and not scored.
 */
export function scoreCross(inp: BiasInputs): RawFactor {
  const x = inp.cross, k = SCALE[inp.horizon];
  const oil = x.cl == null ? null : x.cl >= 2 * k && (x.y10ChgBp ?? 0) > 0 ? -1 : 0;
  const mix = blend([
    [x.dxy == null ? null : -clamp(x.dxy / (0.5 * k), -1, 1), 0.35], [oil, 0.3],
    [x.btc == null ? null : clamp(x.btc / (3 * k), -1, 1), 0.25],
    [x.gc == null ? null : x.gc >= 0.5 * k && (x.dxy ?? 0) > 0 ? -0.5 : 0, 0.1],
  ]);
  if (mix == null || !x.asOf) {
    return x.stale ? { ...none('cross_asset', inp), evidence: `stale, not used: ${x.staleSymbols.join(', ')} candles`, stale: true } : none('cross_asset', inp);
  }
  const part = (n: string, v: number | null): string | null => (v == null ? null : `${n} ${sg(v)}%`);
  const ev = [[part('DXY', x.dxy), part('oil', x.cl), part('gold', x.gc), part('BTC', x.btc)].filter(Boolean).join(', ') + ` ${x.lookbackBars}d`];
  if (oil === -1) ev.push(`oil spiking with the 10Y ${sg(x.y10ChgBp!)} bp`);
  if (x.y10ChgBp != null && x.idxPct != null && x.y10ChgBp <= -8 * k && x.idxPct <= -k) ev.push(`10Y ${sg(x.y10ChgBp)} bp with ${inp.instrument} ${sg(x.idxPct)}%: bonds bid as a haven, regime-change flag`);
  return have('cross_asset', 2 * mix, ev.join('; '), x.asOf);
}

export const SCORERS: Record<FactorName, (inp: BiasInputs) => RawFactor> = {
  catalyst: scoreCatalyst, rates: scoreRates, fed: scoreFed, regime: scoreRegime, breadth: scoreBreadth, positioning: scorePositioning,
  news: scoreNews, structure: scoreStructure, calendar: scoreCalendar, cross_asset: scoreCross,
};
export const FACTOR_ORDER = Object.keys(SCORERS) as FactorName[];
export const scoreFactors = (inp: BiasInputs): RawFactor[] => FACTOR_ORDER.map((f) => SCORERS[f](inp));
