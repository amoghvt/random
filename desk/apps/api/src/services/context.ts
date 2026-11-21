/** Shared plumbing for the services: the profile, the kill switch, worker step health and small kv-backed job state. */
import { KV, iso, type Profile, type Store } from '@desk/contracts';
import type { DeskDeps } from '../deps';
import { errText, silentLog, type Log } from '../log';
import { getProfile, seedProfile } from '../profile';

export type { DeskDeps } from '../deps';

export const logOf = (deps: DeskDeps): Log => deps.log ?? silentLog;

/** The stored profile; seeded from profile.yaml the first time it is asked for. */
export async function profileOf(deps: DeskDeps): Promise<Profile> {
  const stored = await getProfile(deps.store, deps.env);
  if (stored) return stored;
  await seedProfile(deps.store);
  const seeded = await getProfile(deps.store, deps.env);
  if (!seeded) throw new Error('No trader profile: profile.yaml could not be loaded');
  return seeded;
}

export const killSwitchOn = async (store: Store): Promise<boolean> => (await store.kvGet<boolean>(KV.killSwitch)) === true;

export interface ReadOnlyState { readOnly: boolean; until: string | null; reason: string | null }
/** Set by the circuit breaker; expires on its own at `until`. */
export async function readOnlyState(store: Store, now: number): Promise<ReadOnlyState> {
  const until = await store.kvGet<string>(KV.readOnlyUntil);
  if (!until || Date.parse(until) <= now) return { readOnly: false, until: null, reason: null };
  return { readOnly: true, until, reason: await store.kvGet<string>(KV.readOnlyReason) };
}

/** Row shape of kv `feeds.health`; worker steps are recorded beside the feeds as `worker:<step>`. */
export interface HealthRow { feed: string; ok: boolean; lastOk: string | null; error: string | null; live: boolean; lastPoll?: string }
export async function recordHealth(store: Store, rows: Array<{ feed: string; ok: boolean; error: string | null }>, now: number): Promise<void> {
  if (rows.length === 0) return;
  const all = (await store.kvGet<HealthRow[]>(KV.feedHealth)) ?? [];
  const at = iso(now);
  for (const r of rows) {
    const prev = all.find((x) => x.feed === r.feed);
    const row: HealthRow = { feed: r.feed, ok: r.ok, lastOk: r.ok ? at : prev?.lastOk ?? null, error: r.error, live: false, lastPoll: at };
    if (prev) Object.assign(prev, row); else all.push(row);
  }
  await store.kvSet(KV.feedHealth, all);
}

export interface StepResult<T> { name: string; ok: boolean; ms: number; error: string | null; value: T | null }
/** Runs one isolated step: a throw is logged and returned, never propagated. */
export async function runStep<T>(deps: DeskDeps, name: string, fn: () => Promise<T>): Promise<StepResult<T>> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { name, ok: true, ms: Date.now() - t0, error: null, value };
  } catch (e) {
    logOf(deps).error(`worker: ${name} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return { name, ok: false, ms: Date.now() - t0, error: errText(e).slice(0, 240), value: null };
  }
}

/** Last run time (ISO) of each named job, in kv `worker.jobs`. */
export async function lastRun(store: Store, job: string): Promise<number | null> {
  const at = (await store.kvGet<Record<string, string>>(KV.workerJobs))?.[job];
  return at ? Date.parse(at) : null;
}
export async function markRun(store: Store, job: string, now: number): Promise<void> {
  await store.kvSet(KV.workerJobs, { ...((await store.kvGet<Record<string, string>>(KV.workerJobs)) ?? {}), [job]: iso(now) });
}
