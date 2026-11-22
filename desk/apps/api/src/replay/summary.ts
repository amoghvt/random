/** The replay summary as the lines the CLI prints. Numbers first; nothing here is computed beyond formatting. */
import { BIAS_TEXT, BiasLabel, ET, dayKey, hhmm, type BaseRate } from '@desk/contracts';
import type { ReplaySummary } from './replay';

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const day = (isoTime: string): string => `${dayKey(isoTime, ET)} ${hhmm(isoTime, ET)} ET`;
const counts = (r: Record<string, number>): string => Object.entries(r).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

function baseRateLines(rates: BaseRate[]): string[] {
  if (rates.length === 0) return ['  none: no pattern reached the minimum sample.'];
  return rates.map((r) => `  ${r.instrument} ${r.tf} ${r.pattern}: ${pct(r.hitRate)}, n=${r.n}, ${r.windowDays}d`);
}

export function formatSummary(s: ReplaySummary): string[] {
  const out: string[] = [];
  out.push(`Replay ${day(s.from)} to ${day(s.to)}. Source: recorded prices and releases; only the timing is synthetic.`);
  out.push(`Instruments: ${s.instruments.join(', ')}. Horizons: ${s.horizons.join(', ')}. Step asked: ${s.stepMin} min.`);
  out.push('Resolution by period:');
  for (const p of s.periods) out.push(`  ${dayKey(p.from, ET)} to ${dayKey(p.to, ET)}: ${p.resolution} candles, ${p.stepMin}-min steps, ${p.steps} steps`);
  out.push(`Steps: ${s.steps.run} run, ${s.steps.marketClosed} skipped with the market closed, ${s.steps.failureCount} stage failures.`);
  for (const f of s.steps.failures) out.push(`  failed ${f.at} ${f.step}: ${f.error}`);

  out.push(`Calls: ${s.calls.total}. ${BiasLabel.options.map((l) => `${BIAS_TEXT[l]} ${s.calls.byLabel[l]}`).join(', ')}.`);
  out.push(`  by horizon: ${counts(s.calls.byHorizon)}`);
  out.push(`  by trigger: ${counts(s.calls.byTrigger)}`);
  const r = s.calls.resolvedDirectional;
  out.push(`Directional calls: ${s.calls.directional}, resolved ${r}, right ${s.calls.correct}${r > 0 ? ` (${pct(s.calls.correct / r)})` : ''}. Not yet expired: ${s.calls.unresolved} of all calls.`);
  for (const [h, x] of Object.entries(s.calls.hitRateByHorizon)) out.push(`  ${h}: ${x.correct}/${x.n} right (${pct(x.n ? x.correct / x.n : null)})`);
  out.push(`Hit rate by probability bucket (source: ${s.calibration.source}, n=${s.calibration.n}):`);
  for (const b of s.calibration.buckets) out.push(`  ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}: predicted ${b.n ? pct(b.predicted) : 'n/a'}, realized ${pct(b.realized)}, n=${b.n}`);

  out.push(`Catalysts: ${s.catalysts.total} in the window, ${s.catalysts.withMatrix} with a matrix, ${s.catalysts.resolved} resolved to a branch.`);
  out.push('Tier 1:');
  if (s.catalysts.tier1.length === 0) out.push('  none in the window.');
  for (const c of s.catalysts.tier1) {
    const print = c.actual === null ? 'no actual' : `${c.actual}${c.unit ?? ''} vs ${c.centre ?? 'n/a'}${c.centre === null ? '' : c.unit ?? ''}`;
    const branch = c.branchId ? `branch ${c.branchId} "${c.branchLabel ?? ''}" (prior ${pct(c.branchProbability)})` : `no branch. ${c.note ?? ''}`;
    out.push(`  ${day(c.scheduledAt)} ${c.name}: ${print}, ${branch}`);
  }
  out.push('Historical-reaction tables (NQ, last 8 releases per type):');
  for (const t of s.reactionTables) out.push(`  ${t.code}: ${t.rows} rows (${t.on5m} on 5m, ${t.on1h} on 1h, ${t.on1d} on 1d candles)`);
  out.push(`Structure events: ${s.structureEvents}.`);
  out.push(`Base rates: ${s.baseRates.length}.`);
  out.push(...baseRateLines(s.baseRates));
  if (s.removedStale > 0) out.push(`Removed ${s.removedStale} replay docs of an earlier run.`);
  out.push('Not in the recording:');
  for (const m of s.missing) out.push(`  ${m}`);
  out.push('Trades: none. The replay writes no tickets, fills or P&L.');
  return out;
}
