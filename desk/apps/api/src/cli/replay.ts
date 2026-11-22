/**
 * `pnpm replay [--days 90] [--step 15] [--instruments NQ,NVDA | all] [--horizons intraday,swing,position] [--from ISO] [--to ISO]`
 *
 * Walks the recorded prices and releases and writes calls, catalysts, structure events, base rates and the calibration
 * table into the configured store (Postgres when DATABASE_URL is set, otherwise an in-memory store that only yields
 * the printed summary). Safe to run twice: ids are deterministic and every doc is an upsert.
 *
 * The default is the primary instrument on every horizon. `--instruments all` adds a swing call per watchlist name:
 * about 250 more calls a day at 23 kB each, so expect an hour and several hundred MB.
 */
import { DAY, Horizon, KV, Profile, iso, type Store } from '@desk/contracts';
import { createStore, migrateStore, PgStore } from '@desk/db';
import { parseEnv } from '../env';
import { consoleLog } from '../log';
import { loadProfileYaml } from '../profile';
import { formatSummary, replay, replayWindow } from '../replay';

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
    const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    const v = inline ?? argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    out[k] = v;
  }
  return out;
}
const KNOWN = ['days', 'step', 'instruments', 'horizons', 'from', 'to'];

function positive(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number, got ${raw}`);
  return n;
}
function instant(name: string, raw: string): number {
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new Error(`--${name} is not a time: ${raw}`);
  return t;
}

async function instrumentsFor(store: Store, raw: string | undefined): Promise<string[] | undefined> {
  if (raw === 'all') return undefined;
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  const stored = await store.kvGet<unknown>(KV.profile);
  const profile = stored === null ? await loadProfileYaml() : Profile.parse(stored);
  return [profile.instruments.primary[0] ?? 'NQ'];
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  const unknown = Object.keys(a).filter((k) => !KNOWN.includes(k));
  if (unknown.length) throw new Error(`Unknown option --${unknown[0]}. Options: ${KNOWN.map((k) => `--${k}`).join(' ')}`);
  const days = positive('days', a.days, 90);
  const stepMin = positive('step', a.step, 15);
  const horizons = a.horizons?.split(',').map((h) => Horizon.parse(h.trim()));
  const window = replayWindow(days, Date.now());
  const to = a.to ? instant('to', a.to) : window.to;
  const from = a.from ? instant('from', a.from) : a.to ? to - days * DAY : window.from;

  const store = createStore(parseEnv());
  try {
    const pg = store instanceof PgStore;
    if (pg) await migrateStore(store);
    console.log(`Replaying ${iso(from)} to ${iso(to)} into ${pg ? 'Postgres (DATABASE_URL)' : 'an in-memory store (DATABASE_URL is not set: only this summary is kept)'}.`);
    const instruments = await instrumentsFor(store, a.instruments);
    const summary = await replay(store, { from, to, stepMin, ...(instruments ? { instruments } : {}), ...(horizons ? { horizons } : {}), log: consoleLog });
    console.log('');
    for (const line of formatSummary(summary)) console.log(line);
  } finally {
    await store.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
