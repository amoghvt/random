/**
 * `tsx src/cli/catalyst-backtest.ts [--contracts 18.5] [--room 400] [--balance 10000] [--fee 400] [--slip 0.5] [--json out.json]`
 *
 * The trader's own style, tested on every recorded Tier-1 release (core CPI, PPI, NFP, FOMC) since 2024-07:
 * the matrix is rebuilt as of 20:00 ET the night before from data dated before then, the real print is matched to a
 * branch, and that branch's trade is priced on a Vest NQ perp account two ways:
 *  - full port: `--contracts` NQ contracts ($1 per point each); the fail price is `--room` dollars away.
 *  - plan-sized: the contracts that put the plan's invalidation at 80% of the room (the desk's 20% cushion), capped at full port.
 * Entry is the open of the first bar at or after the plan's entry time (the "second move" time), with the plan's
 * targets and invalidation moved to that price at their original distances; the second-move condition itself
 * (10Y confirming) is not checked. Bars are 1h before 2026-09-13, 5m after, 1m from 2026-11-13.
 * Each release is priced on a fresh account: a blown account costs the fee, a win is claimed.
 */
import { writeFileSync } from 'node:fs';
import { DAY, iso, type BiasCall, type Timeframe } from '@desk/contracts';
import { backtest } from '@desk/engines';
import { buildCatalysts } from '@desk/engines/catalyst/build.ts';
import { buildRateHistory } from '@desk/engines/catalyst/history.ts';
import { matchRelease, reanchorPlan } from '@desk/engines/catalyst/live.ts';
import { generateMatrix, matrixRunTimes } from '@desk/engines/catalyst/matrix.ts';
import { asKnownAt, candlesAsOf, lastPrice, loadProfile, recordedEvents, regimeAsOf } from '@desk/engines/catalyst/recorded.testkit.ts';
import { loadRecordedCandles } from '@desk/feeds';

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i]!.replace(/^--/, '')] = argv[i + 1] ?? '';
  return out;
}

const CODES = [{ code: 'CPI', keyed: 'CORE_CPI' }, { code: 'PPI', keyed: 'PPI' }, { code: 'NFP', keyed: 'NFP' }, { code: 'FOMC', keyed: 'FOMC' }] as const;

function main(): void {
  const a = args(process.argv.slice(2));
  const fullPort = Number(a.contracts ?? 18.5), room = Number(a.room ?? 400), balance = Number(a.balance ?? 10_000);
  const fee = Number(a.fee ?? 400), slip = Number(a.slip ?? 0.5);
  const all = recordedEvents();
  const profile = loadProfile();
  const firstBar = loadRecordedCandles('NQ', '1h')[0]!.t;
  const candles = backtest.stitch((['1h', '5m', '1m'] as Timeframe[]).map((tf) => loadRecordedCandles('NQ', tf)));
  const lastBar = candles[candles.length - 1]!.t;

  const rows: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];
  for (const { code, keyed } of CODES) {
    const targets = all.filter((e) => e.code === keyed && !/yoy/i.test(e.name) && e.actual !== null && Date.parse(e.time) > firstBar + 30 * DAY && Date.parse(e.time) < lastBar - DAY);
    for (const target of targets) {
      const tag = `${target.time.slice(0, 10)} ${code}`;
      const now = Date.parse(matrixRunTimes({ scheduledAt: target.time }).dayBefore);
      const known = asKnownAt(all, now);
      const todays = known.filter((e) => e.time === target.time);
      const vixBars = candlesAsOf('VIX', now, ['1d'])['1d']!;
      const vix = vixBars[vixBars.length - 1];
      let catalyst;
      try {
        catalyst = buildCatalysts(todays, [], { now, pastEvents: known, candlesByTf: candlesAsOf('NQ', now), ...(vix ? { vix: { value: vix.c, asOf: iso(vix.t) } } : {}) }).find((c) => c.code === code);
      } catch (e) { skipped.push(`${tag}: build failed (${String(e).slice(0, 80)})`); continue; }
      if (!catalyst) { skipped.push(`${tag}: no catalyst built`); continue; }
      let matrix;
      try {
        matrix = generateMatrix(catalyst, { now, referencePrice: lastPrice('NQ', now), regime: regimeAsOf(now, known), predictionMarkets: [], profile, pastEvents: known, rateHistory: buildRateHistory(keyed, known, candlesAsOf('US10Y', now), 8, now) });
      } catch (e) { skipped.push(`${tag}: no matrix (${String(e).slice(0, 80)})`); continue; }
      const secondary = code === 'CPI' ? all.find((e) => e.code === 'CPI' && e.time === target.time && !/yoy/i.test(e.name))?.actual ?? undefined : undefined;
      const resolved = matchRelease({ ...catalyst, matrix }, { actual: target.actual as number, ...(secondary != null ? { secondary } : {}), ts: target.time }, Date.parse(target.time) + 2000);
      const branch = matrix.branches.find((b) => b.id === resolved.resolution?.branchId);
      const base = { date: target.time.slice(0, 10), code, actual: target.actual, consensus: target.consensus, branch: branch ? `${branch.id} ${branch.label}` : null, branchProb: branch?.probability ?? null };
      if (!branch) { rows.push({ ...base, traded: false, why: 'no branch (FOMC hold needs a tone read)' }); continue; }
      if (!branch.trade) { rows.push({ ...base, traded: false, why: branch.noTradeReason ?? 'no trade' }); continue; }
      const entryAt = Date.parse(branch.trade.entry.at ?? target.time);
      const entryBar = candles.find((c) => c.t >= entryAt);
      if (!entryBar || entryBar.t - entryAt > 2 * 3_600_000) { rows.push({ ...base, traded: false, why: 'no recorded bar near the entry time' }); continue; }
      // The plan's levels keep their distances from the price at entry (see reanchorPlan).
      const plan = reanchorPlan(branch.trade, entryBar.o);
      const stopPts = Math.abs(plan.referencePrice - plan.invalidation.price);
      const sized = Math.min(fullPort, (0.8 * room) / stopPts);
      const result: Record<string, unknown> = { ...base, traded: true, direction: plan.direction, stopPts: Math.round(stopPts), t1Pts: Math.round(Math.abs(plan.targets[0].price - plan.referencePrice)) };
      for (const [mode, contracts] of [['full', fullPort], ['sized', sized]] as const) {
        const entryPx = entryBar.o;
        const leverage = (contracts * entryPx) / balance;
        const call: BiasCall = {
          id: `${tag} ${mode}`, instrument: 'NQ', horizon: 'intraday', call: plan.direction === 'long' ? 'lean_long' : 'lean_short', probability: branch.probability,
          score: 0, factors: [], facts: [], trade: { ...plan, entry: { kind: 'time', text: plan.entry.text, at: plan.entry.at } }, killCondition: { text: '' }, nextCatalyst: null,
          expiresAt: plan.timeStop.at ?? iso(entryAt + DAY), createdAt: iso(entryAt - 1), trigger: { kind: 'print', ref: tag }, firstMoveUntrusted: false, referencePrice: plan.referencePrice, inputs: {},
        };
        const r = backtest.simulate([call], candles, { kind: 'daily', horizons: ['intraday'] }, { balance, leverage, drawdownPct: (room / balance) * 100, dailyLossPct: null, feeUsd: fee, slippagePts: slip });
        const t = r.trades[0];
        result[mode] = t ? { contracts: Math.round(contracts * 10) / 10, entry: t.entryPrice, exit: t.exit, pnlUsd: Math.round(t.pnlUsd), blown: t.blown } : { contracts: Math.round(contracts * 10) / 10, exit: 'no fill', pnlUsd: 0, blown: false };
      }
      rows.push(result);
    }
  }
  rows.sort((x, y) => String(x.date).localeCompare(String(y.date)));

  console.log(`Tier-1 releases ${iso(firstBar + 30 * DAY).slice(0, 10)} to ${iso(lastBar).slice(0, 10)}. Account $${balance}, $${room} room, $${fee} fee, ${slip} pt slippage per fill. Full port ${fullPort} contracts.`);
  console.log('date        code  actual/cons   branch (prob)              dir    stop  T1   | full port: exit   P&L    | plan-sized: ct  exit   P&L');
  for (const r of rows) {
    const head = `${r.date}  ${String(r.code).padEnd(4)}  ${String(r.actual).padStart(5)}/${String(r.consensus).padEnd(5)}  ${String(r.branch ?? '–').slice(0, 20).padEnd(20)} (${r.branchProb == null ? ' – ' : String(Math.round(Number(r.branchProb) * 100)).padStart(2) + '%'})`;
    if (!r.traded) { console.log(`${head}  no trade: ${r.why}`); continue; }
    const f = r.full as { exit: string; pnlUsd: number }, s = r.sized as { contracts: number; exit: string; pnlUsd: number };
    console.log(`${head}  ${String(r.direction).padEnd(5)} ${String(r.stopPts).padStart(4)} ${String(r.t1Pts).padStart(4)} | ${f.exit.padEnd(7)} ${String(f.pnlUsd).padStart(6)} | ${String(s.contracts).padStart(4)} ${s.exit.padEnd(7)} ${String(s.pnlUsd).padStart(6)}`);
  }
  for (const mode of ['full', 'sized'] as const) {
    const traded = rows.filter((r) => r.traded).map((r) => r[mode] as { pnlUsd: number; blown: boolean; exit: string });
    const wins = traded.filter((t) => t.pnlUsd > 0), blown = traded.filter((t) => t.blown);
    const claimed = wins.reduce((x, t) => x + t.pnlUsd, 0);
    const lossInAccount = traded.filter((t) => t.pnlUsd <= 0 && !t.blown).reduce((x, t) => x + t.pnlUsd, 0);
    console.log(`\n${mode === 'full' ? 'Full port' : 'Plan-sized'}: ${traded.length} trades, ${wins.length} wins (${traded.length ? Math.round((wins.length / traded.length) * 100) : 0}%), ${blown.length} accounts blown. Claimed $${claimed}; fees for blown accounts $${blown.length * fee}; losses kept inside surviving accounts $${lossInAccount}. Net to you $${claimed - blown.length * fee + lossInAccount}.`);
  }
  console.log(`\nReleases with a branch but no trade: ${rows.filter((r) => !r.traded).length}. Not built: ${skipped.length}${skipped.length ? `\n  ${skipped.join('\n  ')}` : ''}`);
  if (a.json) writeFileSync(a.json, JSON.stringify(rows, null, 1));
}

main();
