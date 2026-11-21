import { loadRecordedCandles } from '@desk/feeds/recorded.ts';
const c = loadRecordedCandles('NQ', '1m');
console.log(c.length, new Date(c[0]!.t).toISOString(), new Date(c.at(-1)!.t).toISOString());
const from = Date.parse('2026-11-17T13:00:00Z'), to = Date.parse('2026-11-18T22:00:00Z');
const d = c.filter((x) => x.t >= from && x.t < to);
for (let i = 0; i < d.length; i += 15) {
  const s = d.slice(i, i + 15);
  console.log(new Date(s[0]!.t).toISOString().slice(5, 16), s[0]!.o, Math.max(...s.map((x) => x.h)), Math.min(...s.map((x) => x.l)), s.at(-1)!.c, s.length);
}
