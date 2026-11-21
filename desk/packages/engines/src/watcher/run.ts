/** Runs every detector over every timeframe supplied. Pure and idempotent: the same candles and `now` give the same events with the same ids. */
import type { BaseRate, Candle, StructureEvent, Timeframe } from '@desk/contracts';
import { annotateWithBaseRates } from './baseRates';
import { closedCandles } from './candles';
import { PARAMS, buildContext, type TfContext } from './core';
import { detectDivergence } from './detectors/divergence';
import { detectEmaPosture } from './detectors/ema';
import { detectFvgs, detectOrderBlocks } from './detectors/imbalance';
import { detectRange } from './detectors/range';
import { detectRetrace } from './detectors/retrace';
import { detectStructure } from './detectors/structure';
import { confirmSetups, detectSweeps } from './detectors/sweep';
import { detectLiquidity, detectSwings } from './detectors/swings';
import { detectRetraceVolume, detectSpikes } from './detectors/volume';

export interface DetectorInput {
  instrument: string;
  candles: Partial<Record<Timeframe, Candle[]>>;
  /** Peer candles by symbol (ES, SOX, US10Y...). Compared on the peer candles' own timeframe, which must also be present in `candles`. */
  peers?: Record<string, Candle[]>;
  now: number;
  /** When supplied, matching pattern events state their base rate in `text`. */
  baseRates?: BaseRate[];
  /** Candles per timeframe scanned for events (default 200). */
  scan?: number;
}

const TF_ORDER: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];
/** EMA posture is read where the spec reads it (15m, daily) plus 1h for structure; legs on 1m are noise, so retrace starts at 5m. */
const EMA_TFS = new Set<Timeframe>(['15m', '1h', '1d']);
const RETRACE_TFS = new Set<Timeframe>(['5m', '15m', '1h', '1d']);

/** Every detector on one timeframe. Exposed so base rates can scan a long history with the same code the live loop uses. */
export function detectOnTimeframe(ctx: TfContext): StructureEvent[] {
  const sweeps = detectSweeps(ctx), shifts = detectStructure(ctx);
  return [
    ...detectSwings(ctx), ...detectLiquidity(ctx), ...sweeps, ...confirmSetups(ctx, sweeps, shifts), ...shifts,
    ...detectFvgs(ctx), ...detectOrderBlocks(ctx),
    ...(EMA_TFS.has(ctx.tf) ? detectEmaPosture(ctx) : []),
    ...(RETRACE_TFS.has(ctx.tf) ? [...detectRetrace(ctx), ...detectRetraceVolume(ctx)] : []),
    ...detectSpikes(ctx), ...detectRange(ctx),
  ];
}

export function runDetectors(input: DetectorInput): StructureEvent[] {
  const scan = input.scan ?? PARAMS.scan;
  const contexts = new Map<Timeframe, TfContext>();
  const events: StructureEvent[] = [];
  for (const tf of TF_ORDER) {
    const raw = input.candles[tf];
    if (!raw?.length) continue;
    const ctx = buildContext(input.instrument, tf, closedCandles(raw, input.now), scan);
    contexts.set(tf, ctx);
    events.push(...detectOnTimeframe(ctx));
  }
  for (const sym of Object.keys(input.peers ?? {}).sort()) {
    const peer = input.peers![sym]!;
    const ctx = peer[0] ? contexts.get(peer[0].tf) : undefined;
    if (ctx) events.push(...detectDivergence(ctx, sym, closedCandles(peer, input.now)));
  }
  const byId = new Map<string, StructureEvent>();
  for (const e of events) byId.set(e.id, e);
  const out = [...byId.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  return input.baseRates?.length ? annotateWithBaseRates(out, input.baseRates) : out;
}
