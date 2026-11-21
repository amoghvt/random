import { fileURLToPath } from 'node:url';
import { createStore } from '@desk/db';
import type { Feeds, FetchLike, IngestOpts, LlmClient } from '@desk/feeds';
import type { AppDeps } from './app';
import { createBus } from './bus';
import type { Env } from './env';
import { consoleLog, type Log } from './log';
import { DeskPusher } from './push';
import { createScheduler } from './scheduler';

/**
 * What the services and the worker take. Every extra is optional, so plain AppDeps is a valid DeskDeps:
 * the defaults are the live feed registry, global fetch, the accounts/ directory and the console.
 */
export interface DeskDeps extends AppDeps {
  /** Feed registry for `ingestOnce`. Tests and the replay pass prepared feeds instead of the network. */
  feeds?: Feeds;
  ingest?: Pick<IngestOpts, 'symbols' | 'kinds' | 'force'>;
  /** HTTP for the feeds and the firm-rule scraper. */
  fetch?: FetchLike;
  llm?: LlmClient;
  log?: Log;
  /** Directory of the account rule files; accounts/ at the repo root when omitted. */
  accountsDir?: string;
}

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
