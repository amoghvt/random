/**
 * decideCall: the one function that commits. Rules enforced here (spec section 6):
 *  - never a new call on the same evidence; a new call names its trigger;
 *  - first move after a catalyst is not trusted when it contradicts the branch's rates read;
 *  - no catalyst inside the horizon and no structure signal = No edge, with what would create one;
 *  - every call carries its inputs and replays to the same output.
 */
import { BIAS_TEXT, DAY, DEFAULT_WEIGHTS, MIN, hashId, iso, round, type BiasCall, type BiasLabel, type FactorScore } from '@desk/contracts';
import { etStamp } from './calendar';
import { extractInputs } from './extract';
import { catalystState, scoreFactors, sg, structureSignals, type CatalystState } from './factors';
import { branchTrade, buildTrade, creatorOfEdge, expiryFor, killForTrade } from './plan';
import { DEAD_BAND, LEAN_CAP, P_CAP, P_MIN, applyCalibration, combine, labelFromScore, normaliseWeights, probabilityFromScore, type Composite } from './scoring';
import type { BiasInputs, BiasSnapshot, CalibrationMap, DecideOpts, PrevRef, StoredInputs, Weights } from './types';


export const FIRST_MOVE_MINUTES = 15;

export function storedInputs(call: BiasCall): StoredInputs | null {
  const x = call.inputs as Partial<StoredInputs>;
  return x && typeof x === 'object' && x.features?.v === 1 && x.weights ? (x as StoredInputs) : null;
}

/** What the next decision needs to remember about a call. */
export function prevRef(prev: BiasCall): PrevRef {
  const f = storedInputs(prev)?.features;
  const fm = f?.firstMove;
  return {
    id: prev.id, call: prev.call, createdAt: prev.createdAt, expiresAt: prev.expiresAt,
    killLevel: prev.killCondition.level ?? null, killSide: prev.killCondition.side ?? null,
    timeStopAt: prev.trade?.timeStop.at ?? null,
    firstMoveUntrusted: prev.firstMoveUntrusted ?? false,
    firstMoveEndsAt: prev.firstMoveUntrusted && fm ? iso(Date.parse(fm.resolvedAt) + FIRST_MOVE_MINUTES * MIN) : null,
    seen: f ? {
      prints: f.catalysts.filter((c) => c.status === 'resolved').map((c) => c.id),
      headlines: f.news.items.filter((h) => h.impact >= 2).map((h) => h.id),
      structure: f.structure.map((e) => e.id),
    } : null,
  };
}

/**
 * The new fact since the previous call, or null when the evidence is the same. Order: a print, a level
 * (kill level traded through, or a new MSS / BOS / confirmed setup), a headline of impact 2+, a time stop
 * (including the end of an untrusted first-move window), the expiry.
 */
export function detectTrigger(inp: BiasInputs, prev: PrevRef): BiasCall['trigger'] | null {
  const now = Date.parse(inp.now), made = Date.parse(prev.createdAt);
  const isNew = (id: string, ts: string, seen: string[] | undefined): boolean =>
    (seen ? !seen.includes(id) && Date.parse(ts) > made - DAY : Date.parse(ts) > made);
  const print = inp.catalysts.find((c) => c.status === 'resolved' && c.resolvedAt && isNew(c.id, c.resolvedAt, prev.seen?.prints));
  if (print) return { kind: 'print', ref: print.id };
  const price = inp.levels.price;
  if (prev.killLevel != null && prev.killSide && (prev.killSide === 'above' ? price > prev.killLevel : price < prev.killLevel)) {
    return { kind: 'level', ref: `kill:${prev.killSide}:${prev.killLevel}` };
  }
  const ev = inp.structure.find((e) => (e.detector === 'mss' || e.detector === 'bos' || e.confirmedSetup) && isNew(e.id, e.ts, prev.seen?.structure));
  if (ev) return { kind: 'level', ref: ev.id };
  const head = inp.news.items.find((h) => h.impact >= 2 && isNew(h.id, h.ts, prev.seen?.headlines));
  if (head) return { kind: 'headline', ref: head.id };
  if (prev.firstMoveUntrusted && prev.firstMoveEndsAt && Date.parse(prev.firstMoveEndsAt) <= now) return { kind: 'time_stop', ref: `first_move_window:${prev.id}` };
  if (prev.timeStopAt && Date.parse(prev.timeStopAt) <= now) return { kind: 'time_stop', ref: prev.id };
  if (Date.parse(prev.expiresAt) <= now) return { kind: 'expiry', ref: prev.id };
  return null;
}

/**
 * Inside 15 minutes of a resolved catalyst, the move is untrusted when the 10Y has gone 1 bp+ against the
 * branch's rates read, or the price 0.1%+ against the branch's direction.
 */
export function firstMove(inp: BiasInputs): { untrusted: boolean; line: string } {
  const fm = inp.firstMove;
  if (!fm || fm.minutesSince > FIRST_MOVE_MINUTES) return { untrusted: false, line: '' };
  const yAgainst = fm.y10SinceBp != null && fm.expectedY10Bp !== 0 && Math.abs(fm.y10SinceBp) >= 1 && Math.sign(fm.y10SinceBp) === -Math.sign(fm.expectedY10Bp);
  const pAgainst = fm.priceSincePct != null && fm.expectedDir !== 0 && Math.abs(fm.priceSincePct) >= 0.1 && Math.sign(fm.priceSincePct) === -fm.expectedDir;
  if (!yAgainst && !pAgainst) return { untrusted: false, line: '' };
  const seen = [
    fm.y10SinceBp != null ? `10Y ${sg(fm.y10SinceBp)} bp` : null,
    fm.priceSincePct != null ? `${inp.instrument} ${sg(fm.priceSincePct, 2)}%` : null,
  ].filter(Boolean).join(', ');
  const second = etStamp(Date.parse(fm.resolvedAt) + FIRST_MOVE_MINUTES * MIN);
  return {
    untrusted: true,
    line: `First move, not yet trusted: ${seen} in ${fm.minutesSince.toFixed(0)} min after ${fm.name}, against the ${sg(fm.expectedY10Bp, 0)} bp 10Y read. Second move after ${second} with yields confirming.`,
  };
}

const top3 = (factors: FactorScore[]): string[] =>
  factors.filter((f) => f.weight > 0 && f.score !== 0).sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score)).slice(0, 3).map((f) => f.evidence);

export type Decision = { changed: true; call: BiasCall } | { changed: false };

/** Stage 2: inputs -> call. Pure and deterministic; `replayCall` runs exactly this on a stored call. */
export function decideFromInputs(inp: BiasInputs, prev: PrevRef | null, opts: { weights: Weights; calibration: CalibrationMap | null }): Decision {
  const now = Date.parse(inp.now);
  const trigger: BiasCall['trigger'] | null = prev ? detectTrigger(inp, prev) : { kind: 'initial', ref: 'first call' };
  if (!trigger) return { changed: false };

  const raw = scoreFactors(inp);
  const st: CatalystState = catalystState(inp);
  const fm = firstMove(inp);
  const signals = structureSignals(inp);
  const catMode = st.resolved && st.within2h && !fm.untrusted ? 'resolved' : st.live && !(st.resolved && st.within2h) ? 'live' : 'none';
  const comp: Composite = combine(raw, opts.weights, inp.horizon, catMode);

  let gate = 'scored';
  let label: BiasLabel = labelFromScore(comp.score, comp.agreeing, fm.untrusted);
  if (!st.inPlay && signals.length === 0) { gate = 'no catalyst inside the horizon and no structure signal'; label = 'no_edge'; }
  else if (label === 'no_edge') gate = `score ${sg(comp.score, 2)} inside the ±${DEAD_BAND} dead band`;

  const dir = label.endsWith('long') ? 1 : -1;
  let trade = label === 'no_edge' ? null : branchTrade(inp, dir, st, now) ?? buildTrade(inp, dir, st, now);
  if (label !== 'no_edge' && !trade) { gate = 'no candles to place levels from'; label = 'no_edge'; trade = null; }

  const rawP = probabilityFromScore(Math.abs(comp.score));
  let probability = P_MIN;
  if (label !== 'no_edge') {
    const p = label.startsWith('lean') ? Math.min(rawP, LEAN_CAP) : rawP;
    probability = Math.min(P_CAP, Math.max(P_MIN, Math.floor(applyCalibration(opts.calibration, p) * 100 + 1e-9) / 100));
  }

  const creator = creatorOfEdge(inp, st);
  const drivers = top3(comp.factors);
  const facts = label === 'no_edge'
    ? [`No edge: ${gate}.`, creator.text, ...drivers.slice(0, 1)]
    : fm.untrusted ? [fm.line, ...drivers.slice(0, 2)] : drivers;
  const expiresAt = expiryFor(inp, st, trade, now);
  const stored: StoredInputs = {
    features: inp, weights: opts.weights, calibration: opts.calibration, prev,
    scoring: { weighted: comp.weighted, multiplier: comp.multiplier, score: comp.score, rawProbability: round(rawP, 4), agreeing: comp.agreeing, gate },
  };
  const call: BiasCall = {
    id: hashId('bias', inp.instrument, inp.horizon, inp.now, trigger.kind, trigger.ref),
    instrument: inp.instrument, horizon: inp.horizon, call: label, probability, score: comp.score,
    factors: comp.factors, facts: facts.slice(0, 3), trade,
    killCondition: trade ? killForTrade(inp, trade) : creator.kill,
    nextCatalyst: st.next ? { id: st.next.id, name: st.next.name, at: st.next.scheduledAt } : null,
    expiresAt: iso(expiresAt), createdAt: inp.now, trigger, firstMoveUntrusted: fm.untrusted,
    referencePrice: inp.levels.price,
    inputs: stored as unknown as Record<string, unknown>,
  };
  return { changed: true, call };
}

/**
 * The call for a snapshot. With a previous call for the same instrument and horizon and no new fact, the
 * previous call is returned unchanged (same object, same id).
 */
export function decideCall(snapshot: BiasSnapshot, prev: BiasCall | null, opts: DecideOpts = {}): BiasCall {
  const now = opts.now ?? snapshot.now;
  const mine = prev && prev.instrument === snapshot.instrument && prev.horizon === snapshot.horizon ? prev : null;
  const d = decideFromInputs(extractInputs(snapshot, now), mine ? prevRef(mine) : null, {
    weights: normaliseWeights(opts.weights ?? snapshot.weights ?? DEFAULT_WEIGHTS), calibration: opts.calibration ?? null,
  });
  return d.changed ? d.call : mine!;
}

/** Re-run the decision on a stored call's own inputs. Throws when the call carries none. */
export function replayCall(call: BiasCall): BiasCall {
  const s = storedInputs(call);
  if (!s) throw new Error(`Bias call ${call.id} carries no replayable inputs`);
  const d = decideFromInputs(s.features, s.prev, { weights: s.weights, calibration: s.calibration });
  if (!d.changed) throw new Error(`Bias call ${call.id} does not replay: its stored inputs show no new fact`);
  return d.call;
}

export const callText = (c: BiasCall): string => `${BIAS_TEXT[c.call]}${c.call === 'no_edge' ? '' : `, ${c.probability.toFixed(2)}`}`;
