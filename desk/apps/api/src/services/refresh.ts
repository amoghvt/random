/** A live re-read on demand (pull to refresh, Ask's "check live"): one pass of the same loop the worker runs. */
import type { NowView } from '@desk/contracts';
import { runLoop } from '../worker';
import type { DeskDeps } from './context';
import { nowView } from './now';

const inFlight = new WeakMap<object, Promise<NowView>>();

/** Re-polls the feeds and re-runs the engines, then returns the Now view. Concurrent callers share one pass. */
export function refreshNow(deps: DeskDeps, now: number): Promise<NowView> {
  const key = deps.store;
  let pass = inFlight.get(key);
  if (!pass) {
    pass = (async (): Promise<NowView> => {
      try { return (await runLoop(deps, now)).now ?? await nowView(deps, now); } finally { inFlight.delete(key); }
    })();
    inFlight.set(key, pass);
  }
  return pass;
}
