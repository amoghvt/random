/** Stage 1: snapshot -> compact, serializable factor inputs. Stale values are dropped here and named, never used. */
import {
  DATUM_KEYS, DAY, HOUR, INSTRUMENTS, MIN, dayKey, freshness, iso, mean, round,
  type Catalyst, type Datum, type Headline, type Horizon, type StructureEvent,
} from '@desk/contracts';
import { dayTags, sessionDay } from './calendar';
import { atr, clip, emaSeries, isFresh, pct, view, type View } from './indicators';
import type {
  BiasInputs, BiasSnapshot, BreadthIn, CalendarIn, CalendarTag, CatalystIn, CrossIn, FedIn, FirstMoveIn, NewsIn, PositioningIn,
  RatesIn, RegimeIn, StructureIn, YieldIn,
} from './types';

const r = (x: number | null, dp = 2): number | null => (x == null || !Number.isFinite(x) ? null : round(x, dp));
/** Daily-bar lookback per horizon for relative-performance factors. */
export const LOOKBACK_BARS: Record<Horizon, number> = { intraday: 1, swing: 3, position: 10 };
const INDEX_FUTURES = new Set(['NQ', 'MNQ', 'NQ-PERP', 'ES', 'YM', 'RTY']);

interface Ctx { s: BiasSnapshot; now: number }
const usable = (c: Ctx, key: string): Datum | null => {
  const d = c.s.data[key];
  return d && Date.parse(d.asOf) <= c.now && freshness(d, c.now) !== 'stale' ? d : null;
};
const staleOf = (c: Ctx, key: string): Datum | null => {
  const d = c.s.data[key];
  return d && Date.parse(d.asOf) <= c.now && freshness(d, c.now) === 'stale' ? d : null;
};
const hist = (c: Ctx, key: string): Datum[] => (c.s.dataHistory?.[key] ?? []).filter((d) => Date.parse(d.asOf) <= c.now);
/** Last value stamped at or before `t`, no older than `tol` before it. */
function datumAt(h: Datum[], t: number, tol: number): number | null {
  for (let i = h.length - 1; i >= 0; i--) {
    const a = Date.parse(h[i]!.asOf);
    if (a <= t) return t - a <= tol ? h[i]!.value : null;
  }
  return null;
}
function zScore(h: Datum[], value: number): number | null {
  if (h.length < 20) return null;
  const xs = h.map((d) => d.value), m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  return sd > 0 ? round((value - m) / sd, 2) : null;
}

function yieldIn(c: Ctx, key: string, v: View | null): YieldIn | null {
  const d = usable(c, key), h = hist(c, key);
  const fromCandles = v && !v.stale
    ? {
      chg1hBp: v.ago(HOUR) == null ? null : (v.cur - v.ago(HOUR)!) * 100,
      chg1dBp: v.ref(1) == null ? null : (v.cur - v.ref(1)!) * 100,
      chg5dBp: v.ref(5) == null ? null : (v.cur - v.ref(5)!) * 100,
      chg20dBp: v.ref(20) == null ? null : (v.cur - v.ref(20)!) * 100,
    } : null;
  if (d) {
    const bp = (ms: number, tol: number): number | null => { const p = datumAt(h, c.now - ms, tol); return p == null ? null : (d.value - p) * 100; };
    return {
      level: d.value, asOf: d.asOf, source: d.source, stale: false,
      chg1hBp: r(bp(HOUR, 30 * MIN) ?? fromCandles?.chg1hBp ?? null, 1), chg1dBp: r(bp(DAY, 3 * DAY) ?? fromCandles?.chg1dBp ?? null, 1),
      chg5dBp: r(bp(7 * DAY, 3 * DAY) ?? fromCandles?.chg5dBp ?? null, 1), chg20dBp: r(bp(28 * DAY, 4 * DAY) ?? fromCandles?.chg20dBp ?? null, 1),
    };
  }
  if (v && fromCandles) {
    return { level: round(v.cur, 3), asOf: iso(v.asOf), source: `candles:${v.basis}`, stale: false, chg1hBp: r(fromCandles.chg1hBp, 1), chg1dBp: r(fromCandles.chg1dBp, 1), chg5dBp: r(fromCandles.chg5dBp, 1), chg20dBp: r(fromCandles.chg20dBp, 1) };
  }
  const old = staleOf(c, key);
  const none = { chg1hBp: null, chg1dBp: null, chg5dBp: null, chg20dBp: null };
  if (old) return { level: old.value, asOf: old.asOf, source: old.source, stale: true, ...none };
  if (v) return { level: round(v.cur, 3), asOf: iso(v.asOf), source: `candles:${v.basis}`, stale: true, ...none };
  return null;
}

function ratesIn(c: Ctx, inst: View | null, y10v: View | null): RatesIn {
  const ok = inst && !inst.stale ? inst : null;
  const p = (ref: number | null | undefined): number | null => (ok && ref != null ? r(pct(ok.cur, ref)) : null);
  return {
    y10: yieldIn(c, DATUM_KEYS.rate('US10Y'), y10v), y2: yieldIn(c, DATUM_KEYS.rate('US2Y'), null),
    idx: { chg1hPct: p(ok?.ago(HOUR)), chg1dPct: p(ok?.ref(1)), chg5dPct: p(ok?.ref(5)), chg20dPct: p(ok?.ref(20)) },
  };
}

function fedIn(c: Ctx): FedIn {
  const keys = [DATUM_KEYS.fedHike, DATUM_KEYS.fedCut, DATUM_KEYS.fedImplied] as const;
  const [hike, cut, imp] = keys.map((k) => usable(c, k));
  const anyStale = keys.map((k) => staleOf(c, k)).find((d) => d);
  const first = hike ?? cut ?? imp;
  const d = (cur: Datum | null | undefined, key: string, ms: number, scale: number): number | null => {
    if (!cur) return null;
    const p = datumAt(hist(c, key), c.now - ms, 3 * DAY);
    return p == null ? null : r((cur.value - p) * scale, 3);
  };
  return {
    asOf: first?.asOf ?? anyStale?.asOf ?? null, stale: !first && !!anyStale, source: first?.source ?? anyStale?.source ?? null,
    hike: hike?.value ?? null, cut: cut?.value ?? null, impliedRate: imp?.value ?? null,
    dHike1d: d(hike, keys[0], DAY, 1), dCut1d: d(cut, keys[1], DAY, 1), dHike5d: d(hike, keys[0], 7 * DAY, 1), dCut5d: d(cut, keys[1], 7 * DAY, 1),
    dImplied1dBp: d(imp, keys[2], DAY, 100), dImplied5dBp: d(imp, keys[2], 7 * DAY, 100),
  };
}

const relevantCatalyst = (cat: Catalyst, instrument: string, priceSymbol: string): boolean =>
  cat.instruments.length === 0 || cat.instruments.includes(instrument) || cat.instruments.includes(priceSymbol) || cat.symbol === instrument;

function catalystsIn(c: Ctx, priceSymbol: string): CatalystIn[] {
  const out: CatalystIn[] = [];
  for (const cat of c.s.catalysts) {
    if (!relevantCatalyst(cat, c.s.instrument, priceSymbol)) continue;
    const sched = Date.parse(cat.scheduledAt);
    // A resolution stamped after `now` has not happened yet.
    const res = cat.resolution && Date.parse(cat.resolution.resolvedAt) <= c.now ? cat.resolution : null;
    if (res ? c.now - Date.parse(res.resolvedAt) > 5 * DAY : sched > c.now + 21 * DAY || sched < c.now - DAY) continue;
    const matrix = cat.matrix && Date.parse(cat.matrix.generatedAt) <= c.now ? cat.matrix : null;
    const b = res?.branchId ? matrix?.branches.find((x) => x.id === res.branchId) ?? null : null;
    let expected: CatalystIn['expected'] = null;
    if (!res && matrix) {
      const total = matrix.branches.reduce((a, x) => a + x.probability, 0);
      if (total > 0) {
        const dir = (x: (typeof matrix.branches)[number]): number => (x.trade ? (x.trade.direction === 'long' ? 1 : -1) : x.noTradeReason ? 0 : Math.sign(x.indexRead.closePct));
        expected = {
          closePct: round(matrix.branches.reduce((a, x) => a + x.probability * x.indexRead.closePct, 0) / total, 3),
          skew: round(matrix.branches.reduce((a, x) => a + x.probability * dir(x), 0) / total, 3),
        };
      }
    }
    const reactionAt = res ? Date.parse(res.resolvedAt) + 15 * MIN : Infinity;
    out.push({
      id: cat.id, name: cat.name, code: cat.code, tier: cat.tier,
      status: res ? 'resolved' : sched <= c.now ? 'live' : 'upcoming',
      scheduledAt: cat.scheduledAt, asOf: Date.parse(cat.asOf) <= c.now ? cat.asOf : iso(c.now),
      actual: res?.actual ?? null, consensus: cat.consensus, unit: cat.unit ?? null, impliedMovePct: cat.impliedMovePct,
      resolvedAt: res?.resolvedAt ?? null,
      branch: b ? {
        id: b.id, label: b.label, probability: b.probability, y2Bp: b.ratesRead.y2Bp, y10Bp: b.ratesRead.y10Bp,
        m15Pct: b.indexRead.m15Pct, h1Pct: b.indexRead.h1Pct, closePct: b.indexRead.closePct, trade: b.trade, noTradeReason: b.noTradeReason ?? null,
      } : null,
      reactionM15Pct: c.now >= reactionAt ? cat.reaction?.m15Pct ?? null : null,
      expected,
    });
  }
  return out.sort((a, b) => Date.parse(a.resolvedAt ?? a.scheduledAt) - Date.parse(b.resolvedAt ?? b.scheduledAt)).slice(-12);
}

/** Direction a resolved branch points: its trade if it has one, else the sign of its index read. */
export function branchDir(b: NonNullable<CatalystIn['branch']>, horizon: Horizon): -1 | 0 | 1 {
  if (b.trade) return b.trade.direction === 'long' ? 1 : -1;
  if (b.noTradeReason) return 0;
  return Math.sign(horizon === 'intraday' && b.h1Pct !== 0 ? b.h1Pct : b.closePct) as -1 | 0 | 1;
}

function firstMoveIn(c: Ctx, cats: CatalystIn[], inst: View | null, y10v: View | null): FirstMoveIn | null {
  const cat = [...cats].reverse().find((x) => x.status === 'resolved' && x.branch && c.now - Date.parse(x.resolvedAt!) <= 2 * HOUR);
  if (!cat?.branch || !cat.resolvedAt) return null;
  const at = Date.parse(cat.resolvedAt);
  const key = DATUM_KEYS.rate('US10Y');
  const d = usable(c, key);
  const before = d && Date.parse(d.asOf) > at ? datumAt(hist(c, key), at, 30 * MIN) : null;
  let y10: number | null = d && before != null ? (d.value - before) * 100 : null;
  if (y10 == null && y10v && y10v.basis !== '1d' && y10v.asOf > at) { const p = y10v.at(at); y10 = p == null ? null : (y10v.cur - p) * 100; }
  const p0 = inst && inst.basis !== '1d' ? inst.at(at) : null;
  return {
    catalystId: cat.id, name: cat.name, resolvedAt: cat.resolvedAt, minutesSince: round((c.now - at) / MIN, 1),
    expectedY10Bp: cat.branch.y10Bp, expectedDir: branchDir(cat.branch, c.s.horizon),
    y10SinceBp: r(y10, 1), priceSincePct: p0 == null ? null : r(pct(c.s.price, p0), 2),
  };
}

function regimeIn(c: Ctx, inst: View | null): RegimeIn {
  if (!inst) return { asOf: null, stale: false, d1: null, m15: null };
  const closes = [...inst.refBars.map((b) => b.c), inst.cur];
  const e50 = emaSeries(closes, 50), e200 = emaSeries(closes, 200);
  const last = <T>(xs: T[] | null, back = 0): T | null => xs?.at(-1 - back) ?? null;
  const slope = (xs: number[] | null, back: number): number | null => {
    const a = last(xs), b = last(xs, back);
    return a != null && b != null && Number.isFinite(b) ? r(pct(a, b), 3) : null;
  };
  const window = inst.refBars.slice(-252);
  const today = clip(c.s.candles.d1, c.now).at(-1);
  const high = Math.max(inst.cur, today?.h ?? inst.cur, ...window.map((b) => b.h));
  const m15 = clip(c.s.candles.m15, c.now);
  const mc = m15.map((b) => b.c), m50 = emaSeries(mc, 50), m200 = emaSeries(mc, 200);
  return {
    asOf: iso(inst.asOf), stale: inst.stale,
    d1: closes.length >= 21 ? {
      close: inst.cur, ema50: r(last(e50)), ema200: r(last(e200)), ema200SlopePct: slope(e200, 10),
      ret5Pct: inst.ref(5) == null ? null : r(pct(inst.cur, inst.ref(5)!)), ret20Pct: inst.ref(20) == null ? null : r(pct(inst.cur, inst.ref(20)!)),
      high, highBars: window.length, depthPct: round(pct(inst.cur, high), 2), bars: closes.length,
    } : null,
    m15: isFresh(m15.at(-1), c.now) && mc.length >= 50 ? { close: mc.at(-1)!, ema50: r(last(m50)), ema200: r(last(m200)), ema200SlopePct: slope(m200, 20), bars: mc.length } : null,
  };
}

function relReturns(c: Ctx, symbols: string[], n: number): { rets: Record<string, number | null>; asOf: number | null; stale: string[] } {
  const rets: Record<string, number | null> = {}, stale: string[] = [];
  let asOf: number | null = null;
  for (const sym of symbols) {
    const v = sym === c.s.instrument ? view(c.s.candles, c.now) : view(c.s.peers[sym as keyof BiasSnapshot['peers']], c.now);
    const ref = v?.ref(n);
    if (v?.stale) stale.push(sym);
    if (!v || v.stale || ref == null) { rets[sym] = null; continue; }
    rets[sym] = round(pct(v.cur, ref), 2);
    asOf = asOf == null ? v.asOf : Math.min(asOf, v.asOf);
  }
  return { rets, asOf, stale };
}

function breadthIn(c: Ctx): BreadthIn {
  const n = LOOKBACK_BARS[c.s.horizon];
  const indexSymbol = c.s.peers.QQQ ? 'QQQ' : c.s.instrument;
  const { rets, asOf, stale } = relReturns(c, ['SOX', indexSymbol, 'RSP', 'XLP', 'XLU'], n);
  const ad = usable(c, 'breadth.ad_line');
  const adPrev = ad ? datumAt(hist(c, 'breadth.ad_line'), Date.parse(ad.asOf) - 12 * HOUR, 4 * DAY) : null;
  const have = Object.values(rets).some((x) => x != null) || !!ad;
  return {
    asOf: asOf != null ? iso(asOf) : ad?.asOf ?? null, stale: !have && stale.length > 0, lookbackBars: n,
    sox: rets.SOX ?? null, index: rets[indexSymbol] ?? null, indexSymbol, rsp: rets.RSP ?? null, xlp: rets.XLP ?? null, xlu: rets.XLU ?? null,
    adLine: ad ? { value: ad.value, chg: adPrev == null ? null : ad.value - adPrev } : null, staleSymbols: stale,
  };
}

function positioningIn(c: Ctx, priceSymbol: string, cats: CatalystIn[]): PositioningIn {
  const staleKeys: string[] = [];
  const get = (key: string): Datum | null => { if (staleOf(c, key)) staleKeys.push(key); return usable(c, key); };
  const forSym = (f: (s: string) => string): Datum | null => get(f(c.s.instrument)) ?? (priceSymbol !== c.s.instrument ? get(f(priceSymbol)) : null);
  const withZ = (d: Datum | null): { value: number; z: number | null; asOf: string } | null => (d ? { value: d.value, z: zScore(hist(c, d.key), d.value), asOf: d.asOf } : null);
  const vd = get(DATUM_KEYS.vix), vv = view(c.s.peers.VIX, c.now);
  if (!vd && vv?.stale) staleKeys.push('VIX candles');
  const level = vd?.value ?? (vv && !vv.stale ? vv.cur : null);
  const yr = vv ? vv.refBars.slice(-252).map((b) => b.c) : [];
  const termD = get(DATUM_KEYS.vixTerm), v3 = get(DATUM_KEYS.vix3m);
  const term = termD ? { value: termD.value, asOf: termD.asOf } : v3 && level != null ? { value: round(v3.value / level, 3), asOf: v3.asOf } : null;
  const skew = withZ(forSym(DATUM_KEYS.skew)), putCall = withZ(forSym(DATUM_KEYS.putCall)), cftc = withZ(forSym(DATUM_KEYS.cftc));
  const vix = level == null ? null : {
    level: round(level, 2), pctile1y: yr.length >= 60 ? round(yr.filter((x) => x <= level).length / yr.length, 3) : null,
    asOf: vd?.asOf ?? iso(vv!.asOf), source: vd?.source ?? `candles:${vv!.basis}`,
  };
  const stamps = [vix?.asOf, term?.asOf, skew?.asOf, putCall?.asOf, cftc?.asOf].filter((x): x is string => !!x).sort();
  return {
    asOf: stamps[0] ?? null, stale: stamps.length === 0 && staleKeys.length > 0,
    vix, term, skew, putCall, cftc, impliedMovePct: forSym(DATUM_KEYS.impliedMove)?.value ?? null,
    postCatalyst: cats.some((x) => x.status === 'resolved' && c.now - Date.parse(x.resolvedAt!) <= DAY), staleKeys,
  };
}

function relevantHeadline(h: Headline, instrument: string, priceSymbol: string): boolean {
  if (h.symbols.length === 0 || h.symbols.includes(instrument) || h.symbols.includes(priceSymbol)) return true;
  if (h.category === 'macro' || h.category === 'fed' || h.category === 'geopolitical') return true;
  return INDEX_FUTURES.has(priceSymbol) && h.impact >= 3;
}
function newsIn(c: Ctx, priceSymbol: string): NewsIn {
  const items = c.s.headlines
    .filter((h) => { const t = Date.parse(h.ts); return t <= c.now && t > c.now - DAY && h.impact >= 1 && relevantHeadline(h, c.s.instrument, priceSymbol); })
    .sort((a, b) => b.impact - a.impact || Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 25)
    .map((h) => ({ id: h.id, ts: h.ts, impact: h.impact, direction: h.direction, title: h.title.slice(0, 80) }));
  return { asOf: items.map((i) => i.ts).sort().at(-1) ?? null, items };
}

function structureIn(c: Ctx, priceSymbol: string): StructureIn[] {
  return c.s.structure
    .filter((e: StructureEvent) => { const t = Date.parse(e.ts); return (e.instrument === c.s.instrument || e.instrument === priceSymbol) && t <= c.now && t > c.now - 5 * DAY; })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 40)
    .map((e) => ({ id: e.id, detector: e.detector, kind: e.kind, tf: e.tf, ts: e.ts, level: e.level, levelHi: e.levelHi ?? null, bias: e.bias, confidence: e.confidence, confirmedSetup: e.confirmedSetup ?? false, text: e.text.slice(0, 140) }));
}

function calendarIn(c: Ctx, inst: View | null): CalendarIn {
  const day = sessionDay(c.now), tags = dayTags(day);
  const active = (t: ReturnType<typeof dayTags>): string[] => [
    `dow:${t.weekday}`, ...(t.opexWeek ? ['opex_week'] : []), ...(t.opexDay ? ['opex_day'] : []), ...(t.monthEnd ? ['month_end'] : []), ...(t.holidayWeek ? ['holiday_week'] : []),
  ];
  const bars = (inst?.refBars ?? []).slice(-520);
  const byTag = new Map<string, number[]>(active(tags).map((t) => [t, []]));
  for (let i = 1; i < bars.length; i++) {
    const ret = pct(bars[i]!.c, bars[i - 1]!.c);
    // +6h keeps midnight-stamped bars (futures in ET, crypto in UTC) on their own date.
    for (const t of active(dayTags(dayKey(bars[i]!.t + 6 * HOUR)))) byTag.get(t)?.push(ret);
  }
  const stats: CalendarTag[] = [];
  for (const [tag, xs] of byTag) {
    if (xs.length < 2) continue;
    const m = mean(xs), sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
    stats.push({ tag, n: xs.length, meanPct: round(m, 3), t: sd > 0 ? round(m / (sd / Math.sqrt(xs.length)), 2) : 0 });
  }
  return { sessionDay: day, ...tags, tags: stats, historyBars: bars.length };
}

function crossIn(c: Ctx, inst: View | null, y10v: View | null, rates: RatesIn): CrossIn {
  const n = LOOKBACK_BARS[c.s.horizon];
  const { rets, asOf, stale } = relReturns(c, ['DXY', 'CL', 'GC', 'BTC'], n);
  const yRef = y10v && !y10v.stale ? y10v.ref(n) : null;
  const y10 = yRef != null ? (y10v!.cur - yRef) * 100 : n === 1 ? rates.y10?.chg1dBp ?? null : null;
  const iRef = inst && !inst.stale ? inst.ref(n) : null;
  return {
    asOf: asOf == null ? null : iso(asOf), stale: asOf == null && stale.length > 0, lookbackBars: n,
    dxy: rets.DXY ?? null, cl: rets.CL ?? null, gc: rets.GC ?? null, btc: rets.BTC ?? null,
    y10ChgBp: r(y10, 1), idxPct: iRef == null ? null : r(pct(inst!.cur, iRef)), staleSymbols: stale,
  };
}

export function extractInputs(s: BiasSnapshot, now: number = s.now): BiasInputs {
  const c: Ctx = { s, now };
  const spec = INSTRUMENTS[s.instrument];
  const priceSymbol = spec?.priceSymbol ?? s.instrument;
  const inst = view(s.candles, now), y10v = view(s.peers.US10Y, now);
  const cats = catalystsIn(c, priceSymbol);
  const rates = ratesIn(c, inst, y10v);
  const m15 = clip(s.candles.m15, now), h1 = clip(s.candles.h1, now), d1 = clip(s.candles.d1, now);
  return {
    v: 1, now: iso(now), instrument: s.instrument, priceSymbol, horizon: s.horizon,
    rates, fed: fedIn(c), catalysts: cats, firstMove: firstMoveIn(c, cats, inst, y10v),
    regime: regimeIn(c, inst), breadth: breadthIn(c), positioning: positioningIn(c, priceSymbol, cats), news: newsIn(c, priceSymbol),
    structure: structureIn(c, priceSymbol), calendar: calendarIn(c, inst), cross: crossIn(c, inst, y10v, rates),
    levels: {
      price: s.price, lastClose15: isFresh(m15.at(-1), now) ? m15.filter((b) => b.t + 15 * MIN <= now).at(-1)?.c ?? null : null,
      tick: spec?.tickSize ?? 0.01, atrM15: r(atr(m15)), atrH1: r(atr(h1)), atrD1: r(atr(d1)),
    },
  };
}
