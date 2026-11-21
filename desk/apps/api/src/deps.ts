import { fileURLToPath } from 'node:url';
import { createStore } from '@desk/db';
import type { AppDeps } from './app';
import { createBus } from './bus';
import type { Env } from './env';
import { consoleLog, type Log } from './log';
import { DeskPusher } from './push';
import { createScheduler } from './scheduler';

export const WEB_DIR = fileURLToPath(new URL('../../web/out', import.meta.url));

/** Wires the real implementations from the environment. Anything in `over` replaces its default (tests, the replay). */
export function createDeps(env: Env, over: Partial<AppDeps> = {}, log: Log = consoleLog): AppDeps {
  const clock = over.clock ?? Date.now;
  const store = over.store ?? createStore(env);
  const bus = over.bus ?? createBus(env, log);
  const push = over.push ?? new DeskPusher({ store, bus, env, clock, log });
  const scheduler = over.scheduler ?? createScheduler(env, { store, clock, log });
  return { ...over, env, clock, store, bus, push, scheduler };
}

/** Stops the scheduler and releases the bus and the store, in that order. */
export async function closeDeps(deps: AppDeps): Promise<void> {
  await deps.scheduler.stop();
  await deps.bus.close();
  await deps.store.close();
}
