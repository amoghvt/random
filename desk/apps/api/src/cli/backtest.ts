/**
 * `tsx src/cli/backtest.ts --from ISO --to ISO --calls calls.json [--balances 10000,25000,50000] [--fee 400] [--slip 0.5]`
 *
 * Prices the desk's replayed NQ calls as trades on a funded perp account (see packages/engines/src/backtest/sim.ts
 * for the model). If `--calls` does not exist yet, the replay runs first (in memory) and its calls are written there,
 * so later runs over the same window are instant. Prints one table per strategy and account rule set.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DAY, iso, type BiasCall, type Timeframe } from '@desk/contracts';
import { MemoryStore } from '@desk/db';
import { backtest } from '@desk/engines';
import { loadRecordedCandles } from '@desk/feeds';
import { consoleLog } from '../log';
import { replay } from '../replay';

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!, v = argv[i + 1];
    if (!k.startsWith('--') || v === undefined) throw new Error(`Bad argument near ${k}`);
    out[k.slice(2)] = v;
  }
  return out;
}

async function callsFor(path: string, from: number, to: number): Promise<BiasCall[]> {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as BiasCall[];
  const store = new MemoryStore();
  await replay(store, { from, to, stepMin: 15, instruments: ['NQ'], log: consoleLog });
  const calls = (await store.list('bias_calls', { order: 'asc', limit: 1_000_000 })).map((c) => ({ ...c, inputs: {}, factors: c.factors.map((f) => ({ ...f, evidence: '' })) }));
  writeFileSync(path, JSON.stringify(calls));
  return calls;
}

const fmt = (x: number | null, dp = 0): string => (x == null ? '–' : x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const pct = (x: number | null): string => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  const to = a.to ? Date.parse(a.to) : Date.now();
  const from = a.from ? Date.parse(a.from) : to - 90 * DAY;
  const calls = await callsFor(a.calls ?? 'calls.json', from, to);
  const balances = (a.balances ?? '10000,25000,50000').split(',').map(Number);
  const fee = Number(a.fee ?? 400), slip = Number(a.slip ?? 0.5);
  const series = (['1h', '5m', '1m'] as Timeframe[]).map((tf) => loadRecordedCandles('NQ', tf, { from: from - DAY, to: to + 14 * DAY }));
  const candles = backtest.stitch(series);
  const inWindow = calls.filter((c) => { const t = Date.parse(c.createdAt); return t >= from && t <= to; });
  const byH = (h: string): number => inWindow.filter((c) => c.horizon === h && c.call !== 'no_edge').length;
  console.log(`NQ calls ${iso(from).slice(0, 10)} to ${iso(to).slice(0, 10)}: ${inWindow.length} total; directional intraday ${byH('intraday')}, swing ${byH('swing')}, position ${byH('position')}.`);
  console.log(`Fee $${fee} per account, slippage ${slip} pts per fill. Resolution: 1h, then 5m from ${series[1]![0] ? iso(series[1]![0]!.t).slice(0, 10) : 'n/a'}, then 1m from ${series[2]![0] ? iso(series[2]![0]!.t).slice(0, 10) : 'n/a'}.`);

  const rules = [
    { name: 'spec: 6% static floor, 3% daily limit', drawdownPct: 6, dailyLossPct: 3 },
    { name: 'vestmarkets.com Instant: 4% floor, no daily limit', drawdownPct: 4, dailyLossPct: null },
  ];
  const strategies: Array<{ name: string; s: backtest.SimStrategy }> = [
    { name: 'Daily (intraday calls, plan targets and stop)', s: { kind: 'daily', horizons: ['intraday'] } },
    { name: 'Asymmetric 5x fee (swing + position calls, no stop)', s: { kind: 'asymmetric', horizons: ['swing', 'position'], targetFeeMultiple: 5 } },
    { name: 'Asymmetric 10x fee (swing + position calls, no stop)', s: { kind: 'asymmetric', horizons: ['swing', 'position'], targetFeeMultiple: 10 } },
  ];
  const out: unknown[] = [];
  for (const st of strategies) for (const r of rules) {
    console.log(`\n${st.name} | ${r.name}`);
    console.log('balance  lev  trades  win%   avgWin   avgLoss  PF    exp/trade  blown  claimed   fees    NET      green-days  best-day  worst-day');
    for (const b of balances) for (const lev of [2, 5, 10, 25, 50]) {
      const acct: backtest.SimAccount = { balance: b, leverage: lev, drawdownPct: r.drawdownPct, dailyLossPct: r.dailyLossPct, feeUsd: fee, slippagePts: slip };
      const res = backtest.simulate(inWindow, candles, st.s, acct);
      const s = res.stats;
      out.push({ strategy: st.name, rules: r.name, balance: b, leverage: lev, stats: s, trades: res.trades });
      console.log([fmt(b).padStart(7), String(lev).padStart(4), String(s.trades).padStart(6), pct(s.winRate).padStart(6), fmt(s.avgWinUsd).padStart(8), fmt(s.avgLossUsd).padStart(9), (s.profitFactor == null ? '–' : s.profitFactor.toFixed(2)).padStart(5), fmt(s.expectancyUsd).padStart(9), String(s.accountsBlown).padStart(6), fmt(s.claimedUsd).padStart(9), fmt(s.feesUsd).padStart(7), fmt(s.netUsd).padStart(8), `${s.greenDays}/${s.daysTraded}`.padStart(10), fmt(s.bestDayUsd).padStart(9), fmt(s.worstDayUsd).padStart(10)].join(' '));
    }
  }
  if (a.json) writeFileSync(a.json, JSON.stringify(out));
}

main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
