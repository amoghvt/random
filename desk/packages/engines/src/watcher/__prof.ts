import { fromZoned } from '@desk/contracts';
import { loadSessionFixture } from './loadFixture';
import { aggregate, closedCandles } from './candles';
import { buildContext } from './core';
import * as D from './index';
const fx = loadSessionFixture();
const now = fromZoned(2026, 11, 17, 12, 0);
const m1 = fx.m1.NQ!.filter((k) => k.t + 60_000 <= now).slice(-1500);
const time = (name: string, f: () => unknown): void => { const t = performance.now(); for (let i = 0; i < 20; i++) f(); console.log(name, ((performance.now() - t) / 20).toFixed(2), 'ms'); };
for (const tf of ['1m', '15m'] as const) {
  const c = tf === '1m' ? m1 : [...fx.m15History.NQ!, ...aggregate(m1, tf)].slice(-1500);
  time(`${tf} ctx`, () => buildContext('NQ', tf, closedCandles(c, now)));
  const ctx = buildContext('NQ', tf, closedCandles(c, now));
  for (const [n, f] of Object.entries({ swings: D.detectSwings, liq: D.detectLiquidity, sweeps: D.detectSweeps, structure: D.detectStructure, fvg: D.detectFvgs, ob: D.detectOrderBlocks, ema: D.detectEmaPosture, retrace: D.detectRetrace, rvol: D.detectRetraceVolume, spikes: D.detectSpikes, range: D.detectRange })) time(`${tf} ${n}`, () => f(ctx));
}
