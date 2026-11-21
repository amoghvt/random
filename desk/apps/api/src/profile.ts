import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { KV, Profile, type Store } from '@desk/contracts';
import type { Env } from './env';

export const PROFILE_PATH = fileURLToPath(new URL('../../../profile.yaml', import.meta.url));

export async function loadProfileYaml(path: string = PROFILE_PATH): Promise<Profile> {
  return Profile.parse(parse(await readFile(path, 'utf8')));
}

/** Writes profile.yaml into kv when no profile is stored yet. Returns true when it seeded. */
export async function seedProfile(store: Store, path: string = PROFILE_PATH): Promise<boolean> {
  if (await store.kvGet<Profile>(KV.profile)) return false;
  await store.kvSet<Profile>(KV.profile, await loadProfileYaml(path));
  return true;
}

/** The stored profile, with DESK_TZ overriding its timezone when set. Null before the first seed. */
export async function getProfile(store: Store, env: Pick<Env, 'DESK_TZ'>): Promise<Profile | null> {
  const stored = await store.kvGet<unknown>(KV.profile);
  if (stored === null) return null;
  const p = Profile.parse(stored);
  return env.DESK_TZ ? { ...p, timezone: env.DESK_TZ } : p;
}
