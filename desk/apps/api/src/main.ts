import { migrateStore } from '@desk/db';
import { buildApp } from './app';
import { closeDeps, createDeps, WEB_DIR } from './deps';
import { parseEnv } from './env';
import { seedProfile } from './profile';
import { startWorker } from './worker';

async function main(): Promise<void> {
  const env = parseEnv();
  const deps = createDeps(env, { webDir: WEB_DIR });
  const app = buildApp(deps);
  const log = app.log;

  const applied = await migrateStore(deps.store);
  if (applied.length > 0) log.info(`migrations applied: ${applied.join(', ')}`);
  if (await seedProfile(deps.store)) log.info('profile seeded from profile.yaml');
  await deps.bus.ready();
  await deps.push.publicKey();

  if (!env.DATABASE_URL) log.warn('DATABASE_URL is not set: state is in memory and is lost on restart');
  if (!env.REDIS_URL) log.warn('REDIS_URL is not set: bus and scheduler run in this process only');
  if (!env.DESK_TOKEN) log.warn('DESK_TOKEN is not set: the API is open (allowed outside production only)');

  const host = env.HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  await app.listen({ port: env.PORT, host });
  const worker = await startWorker(deps);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info(`${signal}: shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    void (async () => {
      try {
        await worker.stop();
        await app.close();
        await closeDeps(deps);
        process.exit(0);
      } catch (e) {
        log.error(e);
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
