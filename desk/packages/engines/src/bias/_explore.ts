import { fromZoned } from '@desk/contracts';
import { recordedCandlesByKey } from './testkit';
import { snapshotFromHistory, extractInputs, scoreFactors, decideCall, answerUpOrDown } from './index';
const by = recordedCandlesByKey();
for (const [label, now] of [['Fri Nov 20 15:00 ET', fromZoned(2026, 11, 20, 15, 0)], ['Fri Nov 20 16:30 ET', fromZoned(2026, 11, 20, 16, 30)], ['Mon Nov 16 11:00', fromZoned(2026, 11, 16, 11, 0)], ['Sat Nov 21 12:00', fromZoned(2026, 11, 21, 12, 0)]] as const) {
  for (const horizon of ['intraday', 'swing'] as const) {
    const t0 = performance.now();
    const snap = snapshotFromHistory({ now, instrument: 'NQ', horizon, candlesByKey: by, dataHistory: {}, catalysts: [], structure: [], headlines: [] });
    const inp = extractInputs(snap);
    console.log('\n==', label, horizon, 'price', snap.price, `${(performance.now() - t0).toFixed(0)}ms`, 'inputs bytes', JSON.stringify(inp).length);
    if (horizon === 'intraday') console.log(JSON.stringify(inp.regime), JSON.stringify(inp.levels), JSON.stringify(inp.calendar));
    for (const f of scoreFactors(inp)) console.log(' ', f.factor.padEnd(12), String(f.score).padStart(5), f.stale ? 'STALE' : f.missing ? 'MISSING' : '', '|', f.evidence);
    const call = decideCall(snap, null);
    console.log(' ->', call.call, call.probability, call.score, call.facts);
    console.log(answerUpOrDown(call, now));
  }
}
