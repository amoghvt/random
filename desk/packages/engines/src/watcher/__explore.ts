import { loadRecordedCandles } from '@desk/feeds/recorded.ts';
import { fromZoned, hhmm, dayKey } from '@desk/contracts';
const sym = process.argv[2] ?? 'NQ';
const c = loadRecordedCandles(sym, '1m', { from: fromZoned(2026, 11, 15, 17, 0), to: fromZoned(2026, 11, 18, 0, 0) });
console.log(sym, c.length, 'bars');
const B = 15 * 60_000;
const m = new Map<number, { o: number; h: number; l: number; c: number; v: number; n: number; z: number }>();
for (const k of c) {
  const b = Math.floor(k.t / B) * B;
  const e = m.get(b);
  if (!e) m.set(b, { o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, n: 1, z: k.v === 0 ? 1 : 0 });
  else { e.h = Math.max(e.h, k.h); e.l = Math.min(e.l, k.l); e.c = k.c; e.v += k.v; e.n++; if (k.v === 0) e.z++; }
}
for (const [t, e] of m) console.log(dayKey(t), hhmm(t), e.o.toFixed(0), e.h.toFixed(0), e.l.toFixed(0), e.c.toFixed(0), 'v', e.v, 'n', e.n, 'zero', e.z);
