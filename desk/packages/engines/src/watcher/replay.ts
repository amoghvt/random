/** Walk-forward replay: runs the detectors as the live loop does, one step at a time, seeing only candles closed by `now`. */
import type { BaseRate, Candle, StructureEvent, Timeframe } from '@desk/contracts';
import { aggregate } from './candles';
import { runDetectors } from './run';

export interface WalkInput {
  instrument: string;
  /** 1m candles, ascending. Higher timeframes are built from these. */
  m1: Candle[];
  /** Older candles per timeframe, ending before `m1` starts, to warm the EMAs. */
  history?: Partial<Record<Timeframe, Candle[]>>;
  /** Peer 1m candles by symbol; compared on `peerTf`. */
  peersM1?: Record<string, Candle[]>;
  peerTf?: Timeframe;
  from: number; to: number; stepMs?: number;
  tfs?: Timeframe[];
  baseRates?: BaseRate[];
  /** Most recent candles kept per timeframe on each step. */
  maxCandles?: number;
}
export interface FirstSeen { event: StructureEvent; /** The `now` of the step on which the event first appeared. */ at: number }

export function walkForward(input: WalkInput, onStep?: (now: number, fresh: StructureEvent[], all: StructureEvent[]) => void): Map<string, FirstSeen> {
  const tfs = input.tfs ?? ['1m', '5m', '15m', '1h'];
  const step = input.stepMs ?? 60_000, max = input.maxCandles ?? 1500, peerTf = input.peerTf ?? '15m';
  const seen = new Map<string, FirstSeen>();
  for (let now = input.from; now <= input.to; now += step) {
    const m1 = input.m1.filter((k) => k.t + 60_000 <= now);
    const candles: Partial<Record<Timeframe, Candle[]>> = {};
    for (const tf of tfs) {
      const built = tf === '1m' ? m1 : aggregate(m1, tf);
      candles[tf] = [...(input.history?.[tf] ?? []), ...built].slice(-max);
    }
    const peers: Record<string, Candle[]> = {};
    for (const [sym, pm] of Object.entries(input.peersM1 ?? {})) peers[sym] = aggregate(pm.filter((k) => k.t + 60_000 <= now), peerTf).slice(-max);
    const all = runDetectors({ instrument: input.instrument, candles, peers, now, baseRates: input.baseRates });
    const fresh = all.filter((e) => !seen.has(e.id));
    for (const e of fresh) seen.set(e.id, { event: e, at: now });
    onStep?.(now, fresh, all);
  }
  return seen;
}
