/**
 * The replay: the catalyst engine, the chart watcher and the bias engine walked forward over the recorded prices and
 * the recorded data releases, through the same service functions the live loop runs, in the same order.
 *
 * What is real: every candle and every release value (data/recorded). What is synthetic: the timing only. These calls
 * were generated after the fact, so everything the replay writes is tagged (see `isReplayCatalyst`, `isReplayEvent`
 * and `isReplayCall` in services/bias) and the calibration table says `source: 'replay'`.
 *
 * No look-ahead: the walk runs on a private in-memory view of the recording that holds, at each step, only bars that
 * had closed and only the actuals whose release time had passed. The target store is written once, after the walk.
 * Calls are made on raw probabilities (no calibration map is applied during the walk); the map built from their
 * outcomes is what the live engine applies afterwards.
 *
 * What it does not do: no tickets, fills, overrides, guardrail firings, notifications or briefs are written. With no
 * account balance in the view, branch trades are unsized.
 */
import {
  BiasLabel, CORE_SYMBOLS, DAY, EventCode, KV, MIN, Profile, TF_MS, iso,
  type BaseRate, type BiasCall, type Catalyst, type CollectionName, type Collections, type HistoricalReaction, type Horizon, type Store, type StructureEvent, type Timeframe,
} from '@desk/contracts';
import { bias, catalyst as cat } from '@desk/engines';
import { createDeps, closeDeps, type DeskDeps } from '../deps';
import { parseEnv } from '../env';
import { silentLog, type Log } from '../log';
import { loadProfileYaml } from '../profile';
import { biasPlan, isReplayCall, runBias, runCalibration, scoreExpiredCalls, type CalibrationTable } from '../services/bias';
import { runCatalysts } from '../services/catalysts';
import { runStep } from '../services/context';
import { candleReader, priceSymbolOf } from '../services/market';
import { baseRatesDue, computeBaseRates, runWatcher } from '../services/watcher';
import { RecordedView, recordedEnd, resolutionAt } from './view';
import { ViewStore } from './viewStore';

export const REPLAY_SOURCE = 'replay';
/** Prefix on `Catalyst.source` for a catalyst the replay wrote. */
export const REPLAY_SOURCE_PREFIX = 'replay:';
/** kv: the summary of the last replay written into the store, and the per-code historical-reaction tables as of its end. */
export const REPLAY_KV = { summary: 'replay.summary', reactionTables: 'catalysts.reaction_tables' } as const;
export const ALL_HORIZONS: Horizon[] = ['intraday', 'swing', 'position'];

/** A catalyst written by the replay: the source prefix, or the tag on its matrix (which survives a live calendar rebuild). */
export const isReplayCatalyst = (c: Catalyst): boolean => c.source.startsWith(REPLAY_SOURCE_PREFIX) || c.matrix?.inputs.replay === true;
/** A structure event detected in the replay carries `data.replay === true`. */
export const isReplayEvent = (e: StructureEvent): boolean => e.data.replay === true;

export interface ReplayOpts {
  /** Epoch ms. The walk covers [from, to]; `to` is capped at the end of the recording. */
  from: number; to: number;
  /** Minutes between steps. Never finer than the finest recorded bars of the period: 60 where only 1h candles exist. */
  stepMin?: number;
  /** Instruments to call; the profile's primary and watchlist when omitted. The first is the primary (every horizon). */
  instruments?: string[];
  /** Horizons to keep; all three when omitted. */
  horizons?: Horizon[];
  log?: Log;
  /** Called after each step that ran, with the view store as the engines saw it. */
  onStep?: (now: number, view: Store) => void | Promise<void>;
}

export interface ReplayPeriod { from: string; to: string; resolution: Timeframe; stepMin: number; steps: number }
export interface ReplayTier1 {
  id: string; code: string; name: string; scheduledAt: string; actual: number | null; centre: number | null; unit: string | null;
  branchId: string | null; branchLabel: string | null; branchProbability: number | null;
  /** Why no branch was matched, when none was. */
  note: string | null;
}
export interface ReactionTable { code: string; rows: HistoricalReaction[]; on5m: number; on1h: number; on1d: number }

export interface ReplaySummary {
  source: typeof REPLAY_SOURCE;
  from: string; to: string; stepMin: number; instruments: string[]; horizons: Horizon[];
  periods: ReplayPeriod[];
  steps: { run: number; marketClosed: number; failures: Array<{ at: string; step: string; error: string }>; failureCount: number };
  calls: { total: number; byLabel: Record<BiasLabel, number>; byHorizon: Record<string, number>; directional: number; resolvedDirectional: number; correct: number; unresolved: number };
  /** Predicted probability against realized hit rate, from every scored directional call in the target store. */
  calibration: CalibrationTable;
  catalysts: { total: number; withMatrix: number; resolved: number; tier1: ReplayTier1[] };
  reactionTables: Array<{ code: string; rows: number; on5m: number; on1h: number; on1d: number }>;
  structureEvents: number;
  baseRates: BaseRate[];
  /** Replay docs from an earlier run that this run no longer produces, removed from the store. */
  removedStale: number;
  /** What the recording does not contain, so the factors that need it stayed empty. */
  missing: string[];
}

const MISSING = [
  '2Y yield and Fed odds: not in the recording, so the rates factor reads the 10Y only and the fed factor is empty.',
  'Headlines: none recorded. The news factor is empty and an FOMC decision has no tone read, so it resolves no branch.',
  'Earnings dates, options data, CFTC positioning, ETF flows: not recorded.',
  'Consensus revisions: the calendar holds one forecast per release, the one on file when it was recorded.',
  'Account balances: none, so matrix trades are unsized.',
];

const chunk = <T>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
async function putAll<K extends CollectionName>(store: Store, c: K, docs: Array<Collections[K]>): Promise<void> {
  for (const part of chunk(docs, 500)) await store.put(c, part);
}

/** The profile the replay calls on: the stored one (else profile.yaml), narrowed to `instruments` when given. */
async function replayProfile(target: Store, instruments: string[] | undefined): Promise<Profile> {
  const stored = await target.kvGet<unknown>(KV.profile);
  const base = stored === null ? await loadProfileYaml() : Profile.parse(stored);
  if (!instruments || instruments.length === 0) return base;
  const primary = base.instruments.primary.filter((p) => instruments.includes(p));
  const head = primary.length ? primary : [instruments[0]!];
  const taken = new Set(head.map(priceSymbolOf));
  const watchlist = instruments.filter((i) => !head.includes(i) && !taken.has(priceSymbolOf(i)));
  return { ...base, instruments: { ...base.instruments, primary: head, watchlist } };
}

/** Removes replay docs of an earlier run that are not part of this one, so a re-run with other options leaves no orphans. */
async function dropStale<K extends 'bias_calls' | 'catalysts' | 'structure_events'>(
  store: Store, c: K, keep: Set<string>, isReplay: (d: Collections[K]) => boolean, id: (d: Collections[K]) => string, until: number,
): Promise<number> {
  const stale = (await store.list(c, { since: iso(until - 800 * DAY), until: iso(until + 30 * DAY) })).filter((d) => isReplay(d) && !keep.has(id(d)));
  for (const d of stale) await store.remove(c, id(d));
  return stale.length;
}

const tagCall = (c: BiasCall, resolution: Timeframe | null): BiasCall => ({ ...c, inputs: { ...c.inputs, replay: true, replayResolution: resolution } });
const tagEvent = (e: StructureEvent): StructureEvent => ({ ...e, data: { ...e.data, replay: true } });
const tagCatalyst = (c: Catalyst): Catalyst => ({
  ...c, source: c.source.startsWith(REPLAY_SOURCE_PREFIX) ? c.source : `${REPLAY_SOURCE_PREFIX}${c.source}`,
  matrix: c.matrix ? { ...c.matrix, inputs: { ...c.matrix.inputs, replay: true } } : null,
});

function tier1Row(c: Catalyst): ReplayTier1 {
  const branch = c.matrix?.branches.find((b) => b.id === c.resolution?.branchId) ?? null;
  const centre = c.matrix?.inputs.centre;
  let note: string | null = null;
  if (!branch) {
    note = !c.matrix ? cat.cannotPlanReason(c) ?? 'No matrix was generated before the release.'
      : c.resolution?.actual == null && cat.SPECS[c.code]?.centre === 'zero' ? 'Keyed on a number the calendar does not print (tail or tone): actual recorded, no branch.'
      : c.resolution?.actual == null ? 'No actual in the recording.'
      : 'Actual is in; the branch split needs a second read the recording lacks.';
  }
  return {
    id: c.id, code: c.code, name: c.name, scheduledAt: c.scheduledAt, actual: c.resolution?.actual ?? null,
    centre: typeof centre === 'number' ? centre : null, unit: c.unit ?? null,
    branchId: branch?.id ?? null, branchLabel: branch?.label ?? null, branchProbability: branch?.probability ?? null, note,
  };
}

/**
 * Walks the recording from `opts.from` to `opts.to` and writes the result into `store`: bias calls with outcomes,
 * catalysts with matrices and resolutions, structure events, base rates, the calibration table and map, and the
 * reaction tables. Deterministic: the same options on the same recording write the same documents under the same ids.
 */
export async function replay(store: Store, opts: ReplayOpts): Promise<ReplaySummary> {
  const log = opts.log ?? silentLog;
  const stepMin = Math.max(1, Math.round(opts.stepMin ?? 15));
  const horizons = opts.horizons?.length ? ALL_HORIZONS.filter((h) => opts.horizons!.includes(h)) : ALL_HORIZONS;
  const profile = await replayProfile(store, opts.instruments);
  const plan = biasPlan(profile).filter((p) => horizons.includes(p.horizon));
  const called = [...new Set(plan.map((p) => priceSymbolOf(p.instrument)))];
  const primary = priceSymbolOf(profile.instruments.primary[0] ?? 'NQ');
  const end = recordedEnd(primary);
  if (end === null) throw new Error(`No recorded candles for ${primary}: nothing to replay`);
  const to = Math.min(opts.to, end);
  if (!(opts.from < to)) throw new Error(`Replay window is empty: from ${iso(opts.from)} to ${iso(to)} (the recording ends ${iso(end)})`);
  const stepMsAt = (t: number): number => Math.max(stepMin * MIN, TF_MS[resolutionAt(primary, t) ?? '1h']);

  const symbols = [...new Set([...CORE_SYMBOLS, ...bias.PEER_SYMBOLS, ...called, ...profile.instruments.watchlist.map(priceSymbolOf)])];
  const view = new RecordedView(symbols);
  const vstore = new ViewStore();
  const clock = { t: opts.from };
  const deps: DeskDeps = { ...createDeps(parseEnv({}), { store: vstore, clock: () => clock.t }, log), log };
  await vstore.kvSet(KV.profile, profile);
  const weights = await store.kvGet<Record<string, number>>(KV.weights);
  if (weights) await vstore.kvSet(KV.weights, weights);

  const periods: ReplayPeriod[] = [];
  const failures: ReplaySummary['steps']['failures'] = [];
  let failureCount = 0, run = 0, marketClosed = 0, lastPrune = -Infinity, first = true;
  const events = new Map<string, StructureEvent>();
  const resolutionOf = new Map<string, Timeframe | null>();
  const spent: Record<string, number> = {};
  const keepEvent = (e: StructureEvent): void => { const t = Date.parse(e.ts); if (t >= opts.from && t <= to) events.set(e.id, e); };
  const guarded = async <T>(name: string, at: number, fn: () => Promise<T>): Promise<T | null> => {
    const r = await runStep(deps, name, fn);
    spent[name] = (spent[name] ?? 0) + r.ms;
    if (!r.ok) { failureCount++; if (failures.length < 20) failures.push({ at: iso(at), step: name, error: r.error ?? 'failed' }); }
    return r.value;
  };

  try {
    let now = Math.ceil(opts.from / stepMsAt(opts.from)) * stepMsAt(opts.from);
    for (; now <= to; now += stepMsAt(now)) {
      const adv = await view.advance(vstore, now);
      // A closed market prints nothing new: no call is made on it. A release still gets its step.
      if (!first && adv.released === 0 && !called.some((s) => adv.closed.has(s))) { marketClosed++; continue; }
      first = false;
      clock.t = now;
      const resolution = resolutionAt(primary, now);
      const stepMinutes = stepMsAt(now) / MIN;
      const period = periods.at(-1);
      if (period && period.resolution === resolution && period.stepMin === stepMinutes) { period.to = iso(now); period.steps++; }
      else if (resolution) periods.push({ from: iso(now), to: iso(now), resolution, stepMin: stepMinutes, steps: 1 });

      // Same steps, same order as the live loop (worker.runLoop), minus what needs a trader: positions, tickets, guardrails, pushes.
      const reader = candleReader(deps, now);
      if (await baseRatesDue(deps, now)) await guarded('base_rates', now, () => computeBaseRates(deps, now));
      await guarded('watcher', now, () => runWatcher(deps, now, reader));
      await guarded('catalysts', now, () => runCatalysts(deps, now, reader));
      const calls = await guarded('bias', now, async () => { await scoreExpiredCalls(deps, now); return runBias(deps, now, reader); });
      for (const c of calls?.changed ?? []) {
        if (horizons.includes(c.horizon)) resolutionOf.set(c.id, resolution);
        else await vstore.remove('bias_calls', c.id);
      }
      run++;
      if (opts.onStep) await opts.onStep(now, vstore);

      // The engines read five days of structure events; older ones leave the view so its scans stay short.
      if (now - lastPrune >= DAY) {
        lastPrune = now;
        for (const e of await vstore.list('structure_events', { until: iso(now - 6 * DAY) })) { keepEvent(e); await vstore.remove('structure_events', e.id); }
        log.info(`replay: ${iso(now).slice(0, 10)} ${resolution ?? '-'} steps ${run}`);
      }
    }
    const last = view.at;
    log.info(`replay: walk done, ${run} steps; seconds per stage: ${Object.entries(spent).map(([k, v]) => `${k} ${Math.round(v / 1000)}`).join(', ')}`);
    clock.t = last;
    await guarded('bias', last, () => scoreExpiredCalls(deps, last));
    await guarded('base_rates', last, () => computeBaseRates(deps, last));
    for (const e of await vstore.list('structure_events')) keepEvent(e);

    /* ───────── publish ───────── */
    const calls = (await vstore.list('bias_calls', { since: iso(opts.from), until: iso(to + 1), order: 'asc' }))
      .filter((c) => horizons.includes(c.horizon)).map((c) => tagCall(c, resolutionOf.get(c.id) ?? null));
    const catalysts = (await vstore.list('catalysts', { since: iso(opts.from), until: iso(to + 1), order: 'asc' })).map(tagCatalyst);
    const structure = [...events.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id)).map(tagEvent);
    const baseRates = (await vstore.list('base_rates')).sort((a, b) => `${a.instrument}|${a.tf}|${a.pattern}`.localeCompare(`${b.instrument}|${b.tf}|${b.pattern}`));

    let removedStale = 0;
    removedStale += await dropStale(store, 'bias_calls', new Set(calls.map((c) => c.id)), isReplayCall, (c) => c.id, to);
    removedStale += await dropStale(store, 'catalysts', new Set(catalysts.map((c) => c.id)), isReplayCatalyst, (c) => c.id, to);
    removedStale += await dropStale(store, 'structure_events', new Set(structure.map((e) => e.id)), isReplayEvent, (e) => e.id, to);
    await putAll(store, 'bias_calls', calls);
    await putAll(store, 'catalysts', catalysts);
    await putAll(store, 'structure_events', structure);
    await putAll(store, 'base_rates', baseRates);
    await store.kvSet(KV.baseRatesAt, iso(last));

    // Calibration from every scored call in the target store: replay only on a fresh desk, mixed once live calls exist.
    const calibration = await runCalibration({ ...deps, store }, to);
    const map = await store.kvGet<bias.CalibrationMap>(KV.calibration);
    if (map) await store.kvSet(KV.calibration, { ...map, n: calibration.n, source: calibration.source, updatedAt: calibration.updatedAt });

    // One reaction table per catalyst type seen in the window, measured on the recording as of the end of the walk.
    const past = await vstore.list('calendar', { status: EventCode.options.filter((c) => c !== 'OTHER'), until: iso(last), since: iso(last - 800 * DAY), order: 'asc' });
    const reader = candleReader(deps, last);
    const [m5, h1, d1] = await Promise.all([reader.closed('NQ', '5m', 20_000), reader.closed('NQ', '1h', 20_000), reader.closed('NQ', '1d', 900)]);
    const tables: ReactionTable[] = [];
    for (const code of [...new Set(catalysts.filter((c) => c.code !== 'EARNINGS' && c.code !== 'ADHOC' && c.code !== 'OTHER').map((c) => c.keyedOn ?? c.code))].sort()) {
      const rows = cat.buildHistory(code, past, { '5m': m5, '1h': h1, '1d': d1 }, 8, last);
      const on = (r: Timeframe): number => rows.filter((x) => x.resolution === r).length;
      tables.push({ code, rows, on5m: on('5m'), on1h: on('1h'), on1d: on('1d') });
    }
    await store.kvSet(REPLAY_KV.reactionTables, { asOf: iso(last), source: REPLAY_SOURCE, instrument: 'NQ', tables: Object.fromEntries(tables.map((t) => [t.code, t.rows])) });

    const byLabel = Object.fromEntries(BiasLabel.options.map((l) => [l, 0])) as Record<BiasLabel, number>;
    const byHorizon: Record<string, number> = {};
    for (const c of calls) { byLabel[c.call]++; byHorizon[c.horizon] = (byHorizon[c.horizon] ?? 0) + 1; }
    const directional = calls.filter((c) => c.call !== 'no_edge');
    const resolved = directional.filter(bias.isResolvedDirectional);
    const summary: ReplaySummary = {
      source: REPLAY_SOURCE, from: iso(opts.from), to: iso(to), stepMin, instruments: [...new Set(plan.map((p) => p.instrument))], horizons,
      periods, steps: { run, marketClosed, failures, failureCount },
      calls: {
        total: calls.length, byLabel, byHorizon, directional: directional.length, resolvedDirectional: resolved.length,
        correct: resolved.filter((c) => c.outcome?.correct === true).length, unresolved: calls.filter((c) => !c.outcome).length,
      },
      calibration,
      catalysts: {
        total: catalysts.length, withMatrix: catalysts.filter((c) => c.matrix).length, resolved: catalysts.filter((c) => c.resolution?.branchId).length,
        tier1: catalysts.filter((c) => c.tier === 1).map(tier1Row),
      },
      reactionTables: tables.map((t) => ({ code: t.code, rows: t.rows.length, on5m: t.on5m, on1h: t.on1h, on1d: t.on1d })),
      structureEvents: structure.length, baseRates, removedStale, missing: MISSING,
    };
    await store.kvSet(REPLAY_KV.summary, summary);
    return summary;
  } finally {
    await closeDeps(deps);
  }
}

/** The default window: `days` back from the end of the recording (or from `now` when that is earlier). */
export function replayWindow(days: number, now: number, primary = 'NQ'): { from: number; to: number } {
  const end = recordedEnd(primary);
  const to = Math.min(now, end ?? now);
  return { from: to - days * DAY, to };
}
