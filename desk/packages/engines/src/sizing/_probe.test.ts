import { it } from 'vitest';
import { fromZoned, HOUR, dayKey, hhmm } from '@desk/contracts';
import { monitorPosition, sizeTrade, atr, correlationMatrix, worstPlausibleMove } from './index';
import { recorded, rulesOf, syntheticState, lastClose } from './testkit';
import { loadRecordedCandles } from '@desk/feeds/recorded.ts';

it('probe', () => {
  const nq = recorded('NQ');
  for (const [d, h, m] of [[16, 10, 0], [17, 14, 45], [17, 9, 45], [18, 11, 0], [20, 15, 30], [19, 3, 0]] as const) {
    const now = fromZoned(2026, 11, d, h, m);
    const rules = { ...rulesOf('vest-instant'), startingBalance: 10_000 };
    const state = syntheticState(rules, now);
    const mark = lastClose(nq, now);
    const pos = { id: 'p', accountId: rules.id, ticketId: null, instrument: 'NQ-PERP', direction: 'long' as const, units: 500_000, entryPrice: mark, openedAt: new Date(now).toISOString(), liquidationPrice: mark * 0.994, leverage: 50 };
    const st = monitorPosition({ position: pos, rules, state, mark, now, catalysts: [], candles: nq });
    console.log(d, h, m, st.status, st.failBasis, st.distancePts.toFixed(1), st.distancePct.toFixed(3), 'atr', st.atr1m?.toFixed(1), st.worstRemainingPct?.toFixed(2));
    console.log(st.line);
    const sz = sizeTrade({ rules, state, instrument: 'NQ-PERP', direction: 'long', price: mark, entryAt: now, holdUntil: now + 2 * HOUR, now, catalysts: [], candles: nq, targets: [mark * 1.004, mark * 1.008, mark * 1.012] });
    console.log(sz.blocked, sz.blockReason, sz.maxUnits, sz.leverage?.toFixed(2), sz.failPrice?.toFixed(1), sz.failDistancePts?.toFixed(1), sz.failDistancePct?.toFixed(3), sz.worstMove.text, sz.notes, sz.payoutNote, sz.room);
  }
  // share of minutes Critical
  const rules = { ...rulesOf('vest-instant'), startingBalance: 10_000 };
  let crit = 0, n = 0, liqCrit = 0;
  for (let i = 15; i < nq.m1.length; i++) { const a = atr(nq.m1.slice(i - 15, i + 1))!.value; const px = nq.m1[i]!.c; n++; if (px * 0.0006 <= 1.5 * a) crit++; if (px * 0.006 <= 1.5 * a) liqCrit++; }
  console.log('minutes', n, 'critical on 0.06% account fail', crit, (crit / n * 100).toFixed(1), 'critical on 0.6% liq alone', liqCrit);
  const syms = ['NQ', 'NVDA', 'AMZN', 'ES', 'GC', 'CL', 'BTC', 'US10Y', 'VIX'];
  const cm = correlationMatrix(Object.fromEntries(syms.map((s) => [s, loadRecordedCandles(s, '1d')])));
  console.log(Object.fromEntries(syms.map((s) => [s, cm.NQ![s]!.toFixed(2)])));
  // weekend
  const fri = fromZoned(2026, 11, 20, 15, 0);
  const w = worstPlausibleMove({ instrument: 'NQ-PERP', price: lastClose(nq, fri), entryAt: fri, holdUntil: fri + 72 * HOUR, now: fri, catalysts: [], candles: nq, rules });
  console.log(w.text, w.components);
  const s = worstPlausibleMove({ instrument: 'NQ', price: lastClose(nq, fri), entryAt: fri, holdUntil: fri + 5 * 60000, now: fri, catalysts: [], candles: nq });
  console.log(s.text);
  void dayKey; void hhmm;
});
