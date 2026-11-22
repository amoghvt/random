import { MemoryStore } from '@desk/db';
import { replay } from './replay';
const t0 = Date.now();
const store = new MemoryStore();
const from = Date.parse(process.argv[2]!), to = Date.parse(process.argv[3]!);
const inst = process.argv[4] ? process.argv[4].split(',') : undefined;
const s = await replay(store, { from, to, ...(inst ? { instruments: inst } : {}), log: { info: (m) => console.log(m, Date.now() - t0), warn: () => undefined, error: (m) => console.error(m) } });
console.log(JSON.stringify({ ...s, baseRates: s.baseRates.length, missing: undefined }, null, 1));
console.log('ms', Date.now() - t0);
