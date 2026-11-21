/**
 * Bias calls from the store: one snapshot per instrument and horizon, a call stored only when its id changed,
 * outcomes scored at expiry, weekly calibration and the monthly weight re-fit (proposed, applied only on approval).
 */
import {
  DATUM_KEYS, DAY, DEFAULT_WEIGHTS, FactorName, KV, iso,
  type BiasCall, type CalibrationBucket, type Candle, type Datum, type Horizon, type NotificationIntent, type Profile, type Timeframe,
} from '@desk/contracts';
import { bias, notify } from '@desk/engines';
import { profileOf, type DeskDeps } from './context';
import { candleReader, priceSymbolOf, type CandleReader } from './market';

const READ_LIMIT: Record<Timeframe, number> = { '1m': 120, '5m': 60, '15m': 500, '1h': 400, '1d': 900 };
const SNAPSHOT_TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];

/** NQ gets every horizon; each watchlist name gets the swing call its catalysts trade on. */
export function biasPlan(profile: Profile): Array<{ instrument: string; horizon: Horizon }> {
  const primary = profile.instruments.primary[0] ?? 'NQ';
  return [
    ...(['intraday', 'swing', 'position'] as Horizon[]).map((horizon) => ({ instrument: primary, horizon })),
    ...profile.instruments.watchlist.map((instrument) => ({ instrument, horizon: 'swing' as Horizon })),
  ];
}

function datumKeys(symbols: string[]): string[] {
  return [
    DATUM_KEYS.rate('US10Y'), DATUM_KEYS.rate('US2Y'), DATUM_KEYS.fedHike, DATUM_KEYS.fedCut, DATUM_KEYS.fedImplied,
    DATUM_KEYS.vix, DATUM_KEYS.vix3m, DATUM_KEYS.vixTerm, 'breadth.ad_line',
    ...symbols.flatMap((s) => [DATUM_KEYS.skew(s), DATUM_KEYS.putCall(s), DATUM_KEYS.cftc(s), DATUM_KEYS.impliedMove(s)]),
  ];
}

export async function storedWeights(deps: DeskDeps, profile: Profile): Promise<bias.Weights> {
  const kv = await deps.store.kvGet<Record<string, number>>(KV.weights);
  return bias.normaliseWeights({ ...DEFAULT_WEIGHTS, ...(profile.weights as Partial<bias.Weights>), ...((kv ?? {}) as Partial<bias.Weights>) });
}

export async function currentCall(deps: DeskDeps, instrument: string, horizon: Horizon, now: number): Promise<BiasCall | null> {
  return (await deps.store.list('bias_calls', { instrument, status: horizon, until: iso(now + 1), limit: 1 }))[0] ?? null;
}

/** The latest call per instrument and horizon that has not expired. */
export async function currentCalls(deps: DeskDeps, now: number): Promise<BiasCall[]> {
  const recent = await deps.store.list('bias_calls', { since: iso(now - 45 * DAY), until: iso(now + 1) });
  const seen = new Set<string>(), out: BiasCall[] = [];
  for (const c of recent) {
    const k = `${c.instrument}|${c.horizon}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (Date.parse(c.expiresAt) > now) out.push(c);
  }
  return out;
}

export interface BiasStep { calls: BiasCall[]; changed: BiasCall[]; intents: NotificationIntent[]; skipped: string[] }

/** One bias pass. An instrument with no candles in the store is skipped and named. */
export async function runBias(deps: DeskDeps, now: number, reader: CandleReader = candleReader(deps, now)): Promise<BiasStep> {
  const profile = await profileOf(deps);
  const plan = biasPlan(profile);
  const symbols = [...new Set(plan.map((p) => priceSymbolOf(p.instrument)))];
  const [weights, calibration, catalysts, headlines] = await Promise.all([
    storedWeights(deps, profile), deps.store.kvGet<bias.CalibrationMap>(KV.calibration),
    deps.store.list('catalysts', { since: iso(now - 3 * DAY), until: iso(now + 14 * DAY), order: 'asc' }),
    deps.store.list('headlines', { since: iso(now - DAY), until: iso(now + 1) }),
  ]);
  const dataHistory: Record<string, Datum[]> = {};
  for (const key of datumKeys(symbols)) { const h = await deps.store.dataHistory(key, now - 400 * DAY, now); if (h.length) dataHistory[key] = h; }
  const candlesByKey: Record<string, Candle[]> = {};
  const load = async (symbol: string): Promise<void> => {
    for (const tf of SNAPSHOT_TFS) {
      const k = bias.candleKey(symbol, tf);
      if (!(k in candlesByKey)) candlesByKey[k] = await reader.get(symbol, tf, READ_LIMIT[tf]);
    }
  };
  for (const p of bias.PEER_SYMBOLS) await load(p);

  const out: BiasStep = { calls: [], changed: [], intents: [], skipped: [] };
  for (const { instrument, horizon } of plan) {
    const symbol = priceSymbolOf(instrument);
    await load(symbol);
    if (!SNAPSHOT_TFS.some((tf) => (candlesByKey[bias.candleKey(symbol, tf)] ?? []).length > 0)) { if (!out.skipped.includes(instrument)) out.skipped.push(instrument); continue; }
    const structure = await deps.store.list('structure_events', { instrument: symbol, since: iso(now - 5 * DAY), until: iso(now + 1) });
    let snapshot: bias.BiasSnapshot;
    try {
      snapshot = bias.snapshotFromHistory({ now, instrument, horizon, candlesByKey, dataHistory, catalysts, structure, headlines, weights });
    } catch {
      // No bar of this instrument has closed yet: nothing to call on.
      if (!out.skipped.includes(instrument)) out.skipped.push(instrument);
      continue;
    }
    const prev = await currentCall(deps, instrument, horizon, now);
    const call = bias.decideCall(snapshot, prev, { weights, calibration });
    out.calls.push(call);
    if (prev && call.id === prev.id) continue;
    await deps.store.put('bias_calls', [call]);
    await deps.bus.publish('call', call);
    out.changed.push(call);
    const i = notify.biasChanged(prev, call);
    if (i) out.intents.push(i);
  }
  return out;
}

/** Scores every call that has expired and has no outcome yet, on the finest stored candles that cover its life. */
export async function scoreExpiredCalls(deps: DeskDeps, now: number): Promise<BiasCall[]> {
  const open = (await deps.store.list('bias_calls', { since: iso(now - 120 * DAY), until: iso(now + 1) })).filter((c) => !c.outcome && Date.parse(c.expiresAt) <= now);
  const scored: BiasCall[] = [];
  for (const c of open) {
    const from = Date.parse(c.createdAt), to = Date.parse(c.expiresAt);
    for (const tf of SNAPSHOT_TFS) {
      const candles = await deps.store.getCandles(priceSymbolOf(c.instrument), tf, { from: from - DAY, to: Math.min(now, to + DAY) });
      if (candles.length === 0 || candles[0]!.t > from) continue;
      const outcome = bias.scoreOutcome(c, candles);
      if (outcome) { scored.push({ ...c, outcome }); break; }
    }
  }
  if (scored.length) await deps.store.put('bias_calls', scored);
  return scored;
}

/** A call produced by the replay carries `inputs.replay === true`; everything else is live. */
export const isReplayCall = (c: BiasCall): boolean => c.inputs.replay === true;

export interface CalibrationTable { buckets: CalibrationBucket[]; n: number; updatedAt: string | null; source: 'replay' | 'live' | 'mixed' }

/** Weekly: the calibration table from every scored call, and the probability map the engine applies (buckets under 20 calls shift nothing). */
export async function runCalibration(deps: DeskDeps, now: number): Promise<CalibrationTable> {
  const calls = (await deps.store.list('bias_calls', { since: iso(now - 400 * DAY), until: iso(now + 1) })).filter(bias.isResolvedDirectional);
  const result = bias.calibration(calls);
  const replay = calls.filter(isReplayCall).length;
  const table: CalibrationTable = { ...result, updatedAt: iso(now), source: calls.length > 0 && replay === calls.length ? 'replay' : replay === 0 ? 'live' : 'mixed' };
  await deps.store.kvSet(KV.calibrationTable, table);
  await deps.store.kvSet(KV.calibration, bias.buildCalibrationMap(result.buckets));
  return table;
}
export async function calibrationTable(deps: DeskDeps): Promise<CalibrationTable> {
  return (await deps.store.kvGet<CalibrationTable>(KV.calibrationTable)) ?? { ...bias.calibration([]), updatedAt: null, source: 'live' };
}

export interface WeightProposal { proposedAt: string; from: bias.Weights; weights: bias.Weights; report: bias.RefitReport; approved: boolean }

/**
 * Monthly re-fit against the journal's scored calls. The result is a proposal: the engine keeps using the current
 * weights until `applyProposedWeights` runs, which the API calls when the trader approves the weekly memo.
 */
export async function runRefit(deps: DeskDeps, now: number): Promise<WeightProposal> {
  const profile = await profileOf(deps);
  const current = await storedWeights(deps, profile);
  const calls = await deps.store.list('bias_calls', { since: iso(now - 120 * DAY), until: iso(now + 1) });
  const { weights, report } = bias.refitWeights(calls, current);
  const proposal: WeightProposal = { proposedAt: iso(now), from: current, weights, report, approved: false };
  await deps.store.kvSet(KV.refitReport, report);
  if (report.refit) await deps.store.kvSet(KV.proposedWeights, proposal);
  return proposal;
}
export const proposedWeights = (deps: DeskDeps): Promise<WeightProposal | null> => deps.store.kvGet<WeightProposal>(KV.proposedWeights);

/** Applies the pending proposal. Returns the weights now in force, or null when nothing was pending. */
export async function applyProposedWeights(deps: DeskDeps): Promise<bias.Weights | null> {
  const p = await proposedWeights(deps);
  if (!p || p.approved) return null;
  await deps.store.kvSet(KV.weights, p.weights);
  await deps.store.kvSet(KV.proposedWeights, { ...p, approved: true });
  return p.weights;
}

/** Weight moves of the pending proposal in the weekly memo's shape. */
export async function pendingWeightChanges(deps: DeskDeps): Promise<Array<{ factor: string; from: number; to: number; evidence: string }>> {
  const p = await proposedWeights(deps);
  if (!p || p.approved) return [];
  return p.report.moved.filter((m) => FactorName.options.includes(m.factor)).map((m) => ({ factor: m.factor, from: m.from, to: m.to, evidence: m.why }));
}
