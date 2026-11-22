import { MemoryStore } from '@desk/db';
import { replay } from './replay';
const store = new MemoryStore();
await replay(store, { from: Date.parse('2026-11-10T00:00:00Z'), to: Date.parse('2026-11-11T00:00:00Z'), instruments: ['NQ'] });
const calls = await store.list('bias_calls', { order: 'asc' });
const size = calls.map((c) => JSON.stringify(c).length);
console.log('n', calls.length, 'avg bytes', Math.round(size.reduce((a, b) => a + b, 0) / size.length), 'max', Math.max(...size));
const trig: Record<string, number> = {}; const life: Record<string, number[]> = {};
for (const c of calls) { const k = `${c.horizon}:${c.trigger.kind}`; trig[k] = (trig[k] ?? 0) + 1; (life[c.horizon] ??= []).push((Date.parse(c.expiresAt) - Date.parse(c.createdAt)) / 3600000); }
console.log(trig);
for (const [h, xs] of Object.entries(life)) console.log(h, 'life h min/med/max', Math.min(...xs).toFixed(1), xs.sort((a, b) => a - b)[xs.length >> 1]!.toFixed(1), Math.max(...xs).toFixed(1));
const c = calls.find((x) => x.horizon === 'intraday' && x.call !== 'no_edge')!;
console.log(JSON.stringify({ ...c, inputs: undefined }, null, 1).slice(0, 2500));
console.log(Object.entries(c.inputs.features as Record<string, unknown>).map(([k, v]) => `${k}:${JSON.stringify(v).length}`).join(' '));
const refs = calls.filter((x) => x.trigger.kind === 'level').slice(0, 8).map((x) => x.trigger.ref);
const evs = await store.list('structure_events');
console.log(refs.map((r) => { const e = evs.find((x) => x.id === r); return e ? `${e.detector}/${e.kind}/${e.tf}/${e.instrument}` : r; }));
