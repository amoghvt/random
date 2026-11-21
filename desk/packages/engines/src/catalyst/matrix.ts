import { HOUR, INSTRUMENTS, MIN, clamp, dayKey, fmtNum, fmtPct, fromZoned, hhmm, iso, median, round, zoned } from '@desk/contracts';
import type { AccountRules, Catalyst, ScenarioBranch, ScenarioMatrix, TradePlan } from '@desk/contracts';
import {
  BRANCH_IDS, KEYING, MIXED_KEY, MIXED_PRIOR, MIN_SURPRISE_SAMPLE, RATE_PRIOR_BP, SPECS, Y2_PER_Y10,
  fmtValue, pastSurprises, probsFromMarkets, probsFromPrior, probsFromSurprises, regimeBand, secondOrderFor, signFor, slotBounds, slotLabel, slotOf,
} from './branches';
import type { ProbResult, Score, Slot, Spec } from './branches';
import { cashCloseAfter } from './history';
import type { CatalystEx, HistoricalReactionEx, MatrixCtx, RateReaction } from './types';

export const MIN_BUCKET_SAMPLE = 2;
export const MIN_HISTORY_SAMPLE = 4;
/** Stated ratios, used only where the recorded table has no number for the horizon. */
export const M15_OVER_H1 = 0.6;
export const H1_OVER_CLOSE = 0.6;
export const BUCKET_SCALE: Record<number, number> = { 0: 0.5, 1: 1, 2: 1.5 };
export const IMPLIED_SCALE: Record<number, number> = { 0: 0.3, 1: 0.6, 2: 1 };
/** In-line inflation with hikes priced: stated relief in bp (2Y, 10Y). */
export const SQUEEZE_RELIEF_BP: [number, number] = [4, 3];
export const MIN_TRADE_MOVE_PCT = 0.1;
export const NO_TRADE_WAIT_MIN = 45;
export const STRONG_CONVICTION = 0.7;

export interface Magnitude { m15: number; h1: number; close: number; basis: string; n: number }

const abs = (xs: Array<number | null>): number[] => xs.filter((x): x is number => x !== null).map(Math.abs);
const sameInterval = (a: Slot, b: Slot): boolean => a.lo === b.lo && a.hi === b.hi;

export function centreOf(catalyst: Catalyst, spec: Spec): { centre: number; basis: string } | null {
  if (spec.centre === 'zero') return { centre: 0, basis: 'zero' };
  const first = spec.centre === 'prior' ? catalyst.prior : catalyst.consensus;
  const second = spec.centre === 'prior' ? catalyst.consensus : catalyst.prior;
  if (first !== null) return { centre: first, basis: spec.centre };
  if (second !== null) return { centre: second, basis: spec.centre === 'prior' ? 'consensus (no prior on file)' : 'prior (no consensus on file)' };
  return null;
}

/** Null when a matrix can be generated; otherwise the reason it cannot. */
export function cannotPlanReason(catalyst: Catalyst): string | null {
  const spec = SPECS[catalyst.code];
  if (!spec) return `No scenario template for ${catalyst.code}.`;
  return centreOf(catalyst, spec) ? null : `No consensus or prior on file for ${catalyst.name}.`;
}

/** Expected absolute index moves for a slot: same-bucket history, else all-history scaled, else the implied move scaled. */
export function magnitudeFor(catalyst: Catalyst, spec: Spec, slot: Slot, step: number): Magnitude | null {
  const rows = catalyst.history as HistoricalReactionEx[];
  const bucket = Math.abs(slot.score);
  const horizons = (rs: HistoricalReactionEx[], close: number, scale: number): { m15: number; h1: number } => {
    const h1s = abs(rs.map((r) => r.h1Pct)), m15s = abs(rs.map((r) => r.m15Pct ?? null));
    const h1 = h1s.length >= MIN_BUCKET_SAMPLE ? median(h1s) * scale : close * H1_OVER_CLOSE;
    return { h1, m15: m15s.length >= MIN_BUCKET_SAMPLE ? median(m15s) * scale : h1 * M15_OVER_H1 };
  };
  const out = (close: number, h: { m15: number; h1: number }, basis: string, n: number): Magnitude => ({ close: round(close, 2), h1: round(h.h1, 2), m15: round(h.m15, 2), basis, n });
  if (spec.centre === 'consensus' || spec.family === 'earnings') {
    const same = rows.filter((r) => r.surprise !== null && r.closePct !== null && sameInterval(slotOf(spec, r.surprise, step), slot));
    if (same.length >= MIN_BUCKET_SAMPLE) {
      const close = median(abs(same.map((r) => r.closePct)));
      return out(close, horizons(same, close, 1), `same-bucket median of ${same.length} prints`, same.length);
    }
  }
  const all = rows.filter((r) => r.closePct !== null);
  if (all.length >= MIN_HISTORY_SAMPLE) {
    const scale = BUCKET_SCALE[bucket] ?? 1;
    const close = median(abs(all.map((r) => r.closePct))) * scale;
    return out(close, horizons(all, close, scale), `median of the last ${all.length} prints x${scale} (no same-bucket sample)`, all.length);
  }
  if (catalyst.impliedMovePct !== null) {
    const close = catalyst.impliedMovePct * (IMPLIED_SCALE[bucket] ?? 0.6);
    const h1 = close * H1_OVER_CLOSE;
    return out(close, { h1, m15: h1 * M15_OVER_H1 }, `implied move ${catalyst.impliedMovePct}% (${catalyst.impliedMoveSource}) x${IMPLIED_SCALE[bucket] ?? 0.6}`, 0);
  }
  return null;
}

function ratesFor(spec: Spec, slot: Slot, hawk: number, squeeze: boolean, step: number, rateHistory: RateReaction[] | undefined): ScenarioBranch['ratesRead'] {
  const bp = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x)} bp`;
  if (squeeze) return { y2Bp: -SQUEEZE_RELIEF_BP[0], y10Bp: -SQUEEZE_RELIEF_BP[1], text: `2Y ${bp(-SQUEEZE_RELIEF_BP[0])}, 10Y ${bp(-SQUEEZE_RELIEF_BP[1])} as hike premium comes out (stated prior).` };
  const dir = Math.sign(hawk);
  if (dir === 0 || spec.family === 'earnings') return { y2Bp: 0, y10Bp: 0, text: spec.family === 'earnings' ? 'No rates read.' : 'Rates flat.' };
  const same = (rateHistory ?? []).filter((r) => r.surprise !== null && r.closeBp !== null && sameInterval(slotOf(spec, r.surprise, step), slot));
  if (spec.centre === 'consensus' && same.length >= MIN_BUCKET_SAMPLE) {
    const y10 = round(median(abs(same.map((r) => r.closeBp))), 0) * dir, y2 = round(Math.abs(y10) * Y2_PER_Y10, 0) * dir;
    return { y2Bp: y2, y10Bp: y10, text: `2Y ${bp(y2)}, 10Y ${bp(y10)} (10Y: same-bucket median of ${same.length} recorded prints; 2Y: ${Y2_PER_Y10}x, stated).` };
  }
  const [p2, p10] = RATE_PRIOR_BP[spec.family][Math.abs(slot.score)] ?? [0, 0];
  return { y2Bp: p2 * dir, y10Bp: p10 * dir, text: `2Y ${bp(p2 * dir)}, 10Y ${bp(p10 * dir)} (stated prior).` };
}

const tickOf = (symbol: string): number => INSTRUMENTS[symbol]?.tickSize ?? 0.01;
const toTick = (x: number, tick: number): number => round(Math.round(x / tick) * tick, 4);
export const fmtPrice = (x: number): string => fmtNum(x, Number.isInteger(x) ? 0 : 2);
const priceSymbol = (s: string): string => INSTRUMENTS[s]?.priceSymbol ?? s;

export interface AccountFit { accountId: string | null; instrument: string; excluded: Array<{ id: string; name: string; reason: string }> }

/** First supplied account that may take the trade: trades the instrument, allows news trading for a data release, and is not past its flatten time. */
export function fitAccount(accounts: AccountRules[], instrument: string, isDataRelease: boolean, entryAt: number): AccountFit {
  const excluded: AccountFit['excluded'] = [];
  for (const a of accounts) {
    const match = a.instruments.includes(instrument) ? instrument : a.instruments.find((s) => priceSymbol(s) === priceSymbol(instrument));
    if (!match) { excluded.push({ id: a.id, name: a.name, reason: `does not trade ${instrument}` }); continue; }
    const news = a.prohibited.find((p) => p.rule === 'news_trading');
    if (isDataRelease && news) { excluded.push({ id: a.id, name: a.name, reason: 'news trading is prohibited' }); continue; }
    if (a.session.flattenByET !== null && hhmm(entryAt) >= a.session.flattenByET) { excluded.push({ id: a.id, name: a.name, reason: `flat by ${a.session.flattenByET} ET` }); continue; }
    return { accountId: a.id, instrument: match, excluded };
  }
  return { accountId: null, instrument, excluded };
}

/** Second-move entry time: release + offset; for earnings, 09:45 ET on the first cash session after the print. */
export function entryTimeFor(catalyst: Catalyst, spec: Spec): number {
  const T = Date.parse(catalyst.scheduledAt);
  if (spec.family !== 'earnings') return T + spec.entryOffsetMin * MIN;
  for (let i = 0; i < 7; i++) {
    const z = zoned(T + i * 24 * HOUR);
    const at = fromZoned(z.year, z.month, z.day, 9, 45);
    if (at > T && z.weekday >= 1 && z.weekday <= 5) return at;
  }
  return T + 24 * HOUR;
}

function timeStopFor(entryAt: number, catalyst: Catalyst, upcoming: Catalyst[] | undefined): TradePlan['timeStop'] {
  const close = cashCloseAfter(entryAt);
  const next = (upcoming ?? [])
    .filter((c) => c.tier === 1 && c.id !== catalyst.id && Date.parse(c.scheduledAt) > entryAt + 5 * MIN && Date.parse(c.scheduledAt) - 5 * MIN < close)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
  if (next) { const at = Date.parse(next.scheduledAt) - 5 * MIN; return { at: iso(at), text: `Flat by ${hhmm(at)} ET, before ${next.name}.` }; }
  return { at: iso(close), text: `Flat by ${hhmm(close)} ET, the cash close.` };
}

export function buildTrade(args: { instrument: string; sign: 1 | -1; referencePrice: number; movePct: number; entryAt: number; entryText: string; timeStop: TradePlan['timeStop']; accountId: string | null }): TradePlan {
  const { instrument, sign, referencePrice: ref, movePct } = args;
  const tick = tickOf(instrument);
  const at = (mult: number): number => toTick(ref * (1 + (sign * mult * movePct) / 100), tick);
  return {
    instrument, direction: sign > 0 ? 'long' : 'short',
    entry: { kind: 'condition', text: args.entryText, at: iso(args.entryAt) },
    referencePrice: ref,
    targets: [{ price: at(0.5), fraction: 0.333 }, { price: at(1), fraction: 0.333 }, { price: at(1.5), fraction: 0.334 }],
    invalidation: { price: at(-0.5), reason: `${round(movePct / 2, 2)}% against the branch from ${fmtPrice(ref)}: the first move won, the read is wrong.` },
    timeStop: args.timeStop,
    ...(args.accountId ? { accountId: args.accountId } : {}),
  };
}

/** Round to 2 dp and push the residual into the largest so the branch probabilities sum to exactly 1 at 2 dp. */
export function roundToOne(probs: number[]): number[] {
  const r = probs.map((p) => Math.round(p * 100));
  const diff = 100 - r.reduce((a, b) => a + b, 0);
  const i = r.indexOf(Math.max(...r));
  r[i] = (r[i] ?? 0) + diff;
  return r.map((x) => x / 100);
}

export interface MixedParams { primaryCentre: number; primaryHawk: number; secondaryCentre: number; secondaryStep: number; secondaryHawk: number }

/** True when the keyed metric lands outside its in-line branch and the secondary misses its consensus by at least one tick, in opposite hawk directions. */
export function isMixed(spec: Spec, step: number, m: MixedParams, actual: number, secondary: number): boolean {
  const primary = Math.sign(slotOf(spec, actual - m.primaryCentre, step).score) * m.primaryHawk;
  const d = secondary - m.secondaryCentre;
  const sec = (Math.abs(d) >= m.secondaryStep - 1e-9 ? Math.sign(d) : 0) * m.secondaryHawk;
  return primary * sec < 0;
}

function mixedProbability(catalyst: CatalystEx, spec: Spec, step: number, ctx: MatrixCtx, m: MixedParams): { p: number; source: ScenarioBranch['probabilitySource']; basis: string } {
  const keyed = catalyst.keyedOn ?? KEYING[catalyst.code]?.primary ?? catalyst.code;
  const past = (ctx.pastEvents ?? []).filter((e) => Date.parse(e.time) < ctx.now && e.actual !== null && e.consensus !== null);
  let n = 0, k = 0;
  for (const e of past.filter((x) => x.code === keyed)) {
    const sec = past.find((x) => x.code === spec.secondary?.code && x.time === e.time);
    if (!sec) continue;
    n++;
    if (isMixed(spec, step, { ...m, primaryCentre: e.consensus as number, secondaryCentre: sec.consensus as number }, e.actual as number, sec.actual as number)) k++;
  }
  return n >= MIN_SURPRISE_SAMPLE ? { p: (k + 0.5) / (n + 1), source: 'historical', basis: `mixed in ${k} of the last ${n} paired prints` } : { p: MIXED_PRIOR, source: 'prior', basis: 'stated prior' };
}

export function matrixRunTimes(catalyst: Pick<Catalyst, 'scheduledAt'>): { dayBefore: string; dayOf: string } {
  const z = zoned(catalyst.scheduledAt);
  const noon = fromZoned(z.year, z.month, z.day, 12, 0);
  const p = zoned(noon - 24 * HOUR);
  return { dayBefore: iso(fromZoned(p.year, p.month, p.day, 20, 0)), dayOf: iso(fromZoned(z.year, z.month, z.day, 6, 0)) };
}

const pctTxt = (p: number | null): string => (p === null ? 'not on file' : `${Math.round(p * 100)}%`);

function regimeNotes(catalyst: CatalystEx, spec: Spec, ctx: MatrixCtx, excluded: AccountFit['excluded']): string[] {
  const friday = zoned(catalyst.scheduledAt).weekday === 5;
  const notes = ctx.profile.regimeNotes.filter((n) => {
    if (/weekend lock/i.test(n)) return friday;
    if (/\bbeat\b/i.test(n)) return spec.family === 'earnings';
    if (/hot core/i.test(n)) return spec.family === 'inflation';
    if (/second move trades yields/i.test(n)) return spec.family !== 'earnings';
    return true;
  });
  const r = ctx.regime;
  notes.push(`Regime: Fed ${r.fedStance}, hike odds ${pctTxt(r.hikeProb)}, cut odds ${pctTxt(r.cutProb)}, tape in ${r.trend}${r.y10 !== null ? `, 10Y ${r.y10.toFixed(2)}%${r.y10RoundLevelDistanceBp !== null ? ` (${Math.abs(Math.round(r.y10RoundLevelDistanceBp))} bp from a round level)` : ''}` : ''}.`);
  const withFirst = catalyst.history.filter((h) => h.firstMoveReversed !== null);
  if (withFirst.length > 0) notes.push(`First move reversed in ${withFirst.filter((h) => h.firstMoveReversed).length} of the last ${withFirst.length} prints with 5-minute data (${catalyst.history.length} on the table).`);
  const eh = catalyst.earnings?.history ?? [];
  if (spec.family === 'earnings' && eh.length > 0 && catalyst.symbol) {
    notes.push(`${catalyst.symbol} fell after ${eh.filter((h) => h.nextDayPct < 0).length} of its last ${eh.length} prints.`);
  }
  if (catalyst.impliedMovePct !== null) notes.push(`Implied move ${catalyst.impliedMovePct}% (${catalyst.impliedMoveSource}).`);
  for (const e of excluded) notes.push(`${e.name}: ${e.reason}, excluded.`);
  return notes;
}

/** Earnings only: beats that have been sold. Needs 3 beats on file with at least 60% of them lower the next day. */
export function beatsSold(catalyst: CatalystEx, step: number): { sold: boolean; fell: number; beats: number } {
  const beats = (catalyst.earnings?.history ?? []).filter((h) => h.surprisePct !== null && h.surprisePct >= step / 2);
  const fell = beats.filter((h) => h.nextDayPct < 0).length;
  return { sold: beats.length >= 3 && fell / beats.length >= 0.6, fell, beats: beats.length };
}

export function generateMatrix(catalyst: CatalystEx, ctx: MatrixCtx): ScenarioMatrix {
  const spec = SPECS[catalyst.code];
  const c = spec ? centreOf(catalyst, spec) : null;
  if (!spec || !c) throw new Error(cannotPlanReason(catalyst) ?? 'Cannot plan.');
  const step = ctx.steps?.[catalyst.code] ?? spec.step;
  const keyed = catalyst.keyedOn ?? KEYING[catalyst.code]?.primary ?? catalyst.code;
  const day = dayKey(catalyst.scheduledAt);
  const T = Date.parse(catalyst.scheduledAt);

  // Probabilities: prediction markets, else the surprise distribution, else the stated prior.
  const markets = [...ctx.predictionMarkets, ...catalyst.predictionOdds].filter((m) =>
    (m.eventCode === catalyst.code || m.eventCode === keyed) && (m.eventDate === undefined || m.eventDate.slice(0, 10) === day) && Date.parse(m.asOf) <= ctx.now);
  let surprises: number[] = [];
  if (spec.family === 'earnings') surprises = (catalyst.earnings?.history ?? []).map((h) => h.surprisePct).filter((x): x is number => x !== null);
  else if (spec.centre === 'consensus') {
    surprises = pastSurprises(ctx.pastEvents ?? [], keyed, ctx.now);
    if (surprises.length < MIN_SURPRISE_SAMPLE) surprises = catalyst.history.map((h) => h.surprise).filter((x): x is number => x !== null);
  }
  const prob: ProbResult = probsFromMarkets(spec, c.centre, step, markets) ?? probsFromSurprises(spec, step, surprises) ?? probsFromPrior(spec, ctx.regime);

  // Mixed-signal overlay (hot headline with cool core, strong payrolls with unemployment up).
  const secCentre = catalyst.secondary ? catalyst.secondary.consensus ?? catalyst.secondary.prior : null;
  const mixedParams: MixedParams | null = spec.secondary && catalyst.secondary && secCentre !== null
    ? { primaryCentre: c.centre, primaryHawk: spec.hawkSign, secondaryCentre: secCentre, secondaryStep: spec.secondary.step, secondaryHawk: spec.secondary.hawkSign }
    : null;
  let probs = prob.probs;
  let mixed: ReturnType<typeof mixedProbability> | null = null;
  if (mixedParams) {
    mixed = mixedProbability(catalyst, spec, step, ctx, mixedParams);
    const off = spec.slots.reduce((a, s, i) => a + (s.score !== 0 ? probs[i]! : 0), 0);
    const p = Math.min(mixed.p, off * 0.5);
    mixed = { ...mixed, p };
    probs = probs.map((x, i) => (spec.slots[i]!.score !== 0 && off > 0 ? x * (1 - p / off) : x));
  }
  const rounded = roundToOne(mixed ? [...probs, mixed.p] : probs);

  const instrument = catalyst.instruments[0] ?? 'NQ';
  const entryAt = entryTimeFor(catalyst, spec);
  const waitUntil = `${hhmm((spec.family === 'earnings' ? entryAt - 15 * MIN : T) + NO_TRADE_WAIT_MIN * MIN)} ET`;
  const isDataRelease = spec.family !== 'earnings' && spec.family !== 'adhoc';
  const fit = ctx.accounts ? fitAccount(ctx.accounts, instrument, isDataRelease, entryAt) : null;
  const timeStop = timeStopFor(entryAt, catalyst, ctx.upcoming);
  const sold = spec.family === 'earnings' ? beatsSold(catalyst, step) : null;
  const band = regimeBand(ctx.regime);
  const detail: Record<string, unknown> = {};

  const branches: ScenarioBranch[] = spec.slots.map((slot, i) => {
    const id = BRANCH_IDS[i]!;
    const hawkScore = (slot.score * spec.hawkSign) as Score;
    const read = signFor(spec.family, spec.family === 'earnings' ? slot.score : hawkScore, ctx.regime);
    let sign = read.sign;
    let reason = sign === 0 ? secondOrderFor(spec.family, { ...slot, score: hawkScore }, ctx.regime, read) : '';
    if (sold?.sold && slot.slug === 'beat_guide_held') { sign = 0; reason = `${catalyst.symbol} fell after ${sold.fell} of its last ${sold.beats} beats: a beat alone is not the trade.`; }
    const mag = magnitudeFor(catalyst, spec, slot, step);
    const squeeze = spec.family === 'inflation' && hawkScore === 0 && sign > 0;
    const ratesRead = ratesFor(spec, slot, hawkScore, squeeze, step, ctx.rateHistory);
    let trade: TradePlan | null = null;
    if (sign !== 0 && !mag) reason = 'No magnitude on file: no reaction history and no implied move.';
    else if (sign !== 0 && mag && mag.close < MIN_TRADE_MOVE_PCT) reason = `Expected move ${mag.close}% is under ${MIN_TRADE_MOVE_PCT}%: nothing to scale out of.`;
    else if (sign !== 0 && mag) {
      const y = Math.sign(ratesRead.y10Bp);
      const confirm = spec.family === 'earnings'
        ? `if ${instrument} holds ${sign > 0 ? 'above' : 'below'} the first 15-minute range`
        : `if the 10Y confirms: yield ${y > 0 ? 'above' : y < 0 ? 'below' : sign > 0 ? 'not above' : 'not below'} its pre-release level`;
      trade = buildTrade({ instrument: fit?.accountId ? fit.instrument : instrument, sign: sign as 1 | -1, referencePrice: ctx.referencePrice, movePct: mag.close, entryAt, entryText: `Second move after ${hhmm(entryAt)} ET ${confirm}`, timeStop, accountId: fit?.accountId ?? null });
    }
    const m = mag && sign !== 0 ? mag : { m15: 0, h1: 0, close: 0, basis: 'no directional read', n: 0 };
    const hit = mag && sign !== 0 ? (catalyst.history.filter((h) => h.surprise !== null && h.closePct !== null && sameInterval(slotOf(spec, h.surprise, step), slot))) : [];
    const base = 0.56 + 0.03 * Math.abs(slot.score);
    const conviction = sign === 0 ? null : round(clamp(hit.length >= MIN_HISTORY_SAMPLE && spec.centre === 'consensus' ? 0.5 * base + 0.5 * (hit.filter((h) => Math.sign(h.closePct as number) === sign).length / hit.length) : base, 0.5, 0.85), 2);
    detail[id] = { slug: slot.slug, signRule: read.rule, sign, magnitude: mag, conviction };
    const b = slotBounds(slot, c.centre, step);
    return {
      id, label: slotLabel(slot, spec, c.centre, step),
      match: { metric: spec.metric, lo: b.lo, hi: b.hi, key: slot.slug },
      probability: rounded[i]!, probabilitySource: prob.source,
      ratesRead,
      indexRead: { m15Pct: sign * m.m15, h1Pct: sign * m.h1, closePct: sign * m.close, text: sign === 0 ? 'No directional read.' : `${instrument} ${fmtPct(sign * m.m15, 2)} in 15m, ${fmtPct(sign * m.h1, 2)} first hour, ${fmtPct(sign * m.close, 2)} close (${m.basis}).` },
      secondOrder: secondOrderFor(spec.family, { ...slot, score: hawkScore }, ctx.regime, { ...read, sign }),
      trade,
      ...(trade ? {} : { noTradeReason: `No edge, stand aside until ${waitUntil}. ${reason}` }),
    };
  });

  if (mixed && mixedParams && catalyst.secondary && spec.secondary) {
    const id = BRANCH_IDS[branches.length]!;
    detail[id] = { slug: MIXED_KEY, signRule: 'mixed', sign: 0, magnitude: null, conviction: null, basis: mixed.basis };
    branches.push({
      id, label: `Mixed: ${spec.secondary.label} disagrees with the keyed number`,
      match: { metric: `${spec.metric}+${spec.secondary.code.toLowerCase()}`, lo: null, hi: null, key: MIXED_KEY },
      probability: rounded[rounded.length - 1]!, probabilitySource: mixed.source,
      ratesRead: { y2Bp: 0, y10Bp: 0, text: 'Rates two-way.' },
      indexRead: { m15Pct: 0, h1Pct: 0, closePct: 0, text: 'No directional read.' },
      secondOrder: `Keyed number outside the in-line branch, ${spec.secondary.label} off consensus by ${fmtValue(mixedParams.secondaryStep, { dp: 1, unit: '%' })} or more the other way: the first move is noise.`,
      trade: null,
      noTradeReason: `No edge, stand aside until ${waitUntil}. Mixed signal: the ${spec.secondary.label} and the keyed number disagree.`,
    });
  }

  const top = [...branches].sort((a, b) => b.probability - a.probability)[0]!;
  const whatIWouldDo = top.trade
    ? `${top.label} is the base case at ${top.probability.toFixed(2)}: ${top.trade.direction} ${top.trade.instrument}, ${top.trade.entry.text.charAt(0).toLowerCase()}${top.trade.entry.text.slice(1)}, T1 ${fmtPrice(top.trade.targets[0].price)}, out at ${fmtPrice(top.trade.invalidation.price)}.`
    : 'No edge until the print.';

  return {
    catalystId: catalyst.id, generatedAt: iso(ctx.now), referencePrice: ctx.referencePrice, branches,
    regimeNotes: regimeNotes(catalyst, spec, ctx, fit?.excluded ?? []),
    whatIWouldDo,
    inputs: {
      now: ctx.now, referencePrice: ctx.referencePrice, regime: ctx.regime, band,
      catalyst: { id: catalyst.id, code: catalyst.code, keyedOn: keyed, scheduledAt: catalyst.scheduledAt, consensus: catalyst.consensus, prior: catalyst.prior, impliedMovePct: catalyst.impliedMovePct, impliedMoveSource: catalyst.impliedMoveSource, historyRows: catalyst.history.length },
      secondary: catalyst.secondary ?? null,
      centre: c.centre, centreBasis: c.basis, step, unit: spec.unit, dp: spec.dp,
      probabilityBasis: prob.basis, surpriseSample: surprises.length, marketIds: markets.map((m) => m.id),
      mixed: mixedParams, mixedBasis: mixed?.basis ?? null,
      branches: detail,
      account: fit ? { chosen: fit.accountId, excluded: fit.excluded } : null,
      entryAt: iso(entryAt), timeStop,
      rateSample: ctx.rateHistory?.length ?? 0,
    },
  };
}

/** Conviction of a branch's trade (0.50 to 0.85), from the matrix inputs. Null for a no-trade branch. */
export function branchConviction(matrix: ScenarioMatrix, branchId: string): number | null {
  const d = (matrix.inputs.branches as Record<string, { conviction: number | null }> | undefined)?.[branchId];
  return d?.conviction ?? null;
}
