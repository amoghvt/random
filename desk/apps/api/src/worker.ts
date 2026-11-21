import type { AppDeps } from './app';

export interface WorkerHandle { stop(): Promise<void> }

/**
 * The desk's background work: the 60-second ingest/engine loop and the daily jobs (morning brief, recap,
 * weekly review, rule-diff check). Register each with `deps.scheduler.every(...)` / `.cron(...)` before
 * `start()`. No jobs are registered yet; the integrator adds them here.
 */
export async function startWorker(deps: AppDeps): Promise<WorkerHandle> {
  await deps.scheduler.start();
  return { stop: () => deps.scheduler.stop() };
}
