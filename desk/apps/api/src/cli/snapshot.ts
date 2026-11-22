/**
 * One-shot snapshot: boots the desk on an in-memory store, pulls the live free feeds, runs one pass of the
 * autonomous loop and writes the resulting views as JSON documents. Used to feed a hosted page that cannot
 * run the worker itself. Usage: tsx src/cli/snapshot.ts <out.json>
 */
import { writeFileSync } from 'node:fs';
import { DAY, iso, type Candle, type Timeframe } from '@desk/contracts';
import { MemoryStore } from '@desk/db';
import { createDeps, closeDeps } from '../deps';
import { parseEnv } from '../env';
import { backfillOnBoot, runLoop, runMatrices } from '../worker';
import { loadRules } from '../services/accounts';

const ema = (cs: Candle[], n: number): Array<{ t: number; v: number }> => {
  const k = 2 / (n + 1);
  let e: number | null = null;
  return cs.map((c) => { e = e === null ? c.c : c.c * k + e * (1 - k); return { t: c.t, v: Math.round(e * 100) / 100 }; });
};

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error('usage: snapshot <out.json>');
  const quiet = { info: () => undefined, warn: () => undefined, error: (m: string) => console.error(m) };
  const deps = createDeps(parseEnv({}), { store: new MemoryStore() }, quiet as never);
  const now = Date.now();
  const steps: Record<string, unknown> = {};
  steps.backfill = await backfillOnBoot(deps, now).catch((e: unknown) => String(e));
  const first = await runLoop(deps, now);
  steps.matrices = await runMatrices(deps, now).catch((e: unknown) => String(e));
  const loop = await runLoop(deps, Date.now());
  const store = deps.store;
  const charts: Record<string, unknown> = {};
  for (const tf of ['15m', '1h', '1d'] as Timeframe[]) {
    const cs = await store.getCandles('NQ', tf, { limit: 260 });
    charts[tf] = { candles: cs.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]), e20: ema(cs, 20).slice(-260), e50: ema(cs, 50).slice(-260), e200: ema(cs, 200).slice(-260), source: cs.at(-1)?.source ?? null };
  }
  const slim = <T extends { inputs?: unknown }>(c: T): T => ({ ...c, inputs: {} });
  const view = loop.now ?? first.now;
  const doc = {
    generatedAt: iso(Date.now()),
    now: view ? { ...view, primary: view.primary ? slim(view.primary) : null, calls: view.calls.map(slim) } : null,
    loop: { steps: loop.steps, events: loop.events, updates: loop.updates, intents: loop.intents, firstSteps: first.steps, ...steps },
    catalysts: await store.list('catalysts', { since: iso(now - 3 * DAY), until: iso(now + 8 * DAY), order: 'asc', limit: 80 }),
    structure: await store.list('structure_events', { instrument: 'NQ', limit: 40 }),
    updates: await store.list('watcher_updates', { limit: 30 }),
    baseRates: await store.list('base_rates', { limit: 40 }),
    headlines: await store.list('headlines', { limit: 25 }),
    notifications: await store.list('notifications', { limit: 30 }),
    briefs: await store.list('briefs', { limit: 5 }),
    rules: await loadRules(deps),
    charts,
  };
  writeFileSync(out, JSON.stringify(doc));
  console.log(JSON.stringify({ out, bytes: JSON.stringify(doc).length, steps: loop.steps.map((s) => `${s.name}:${s.ok ? 'ok' : s.error}`), catalysts: doc.catalysts.length, calls: doc.now?.calls.length ?? 0, structure: doc.structure.length }, null, 1));
  await closeDeps(deps);
}
main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
