/** File IO: reads accounts/*.yaml. Kept out of the pure engine files. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AccountRules } from '@desk/contracts';

export const ACCOUNTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../accounts');

/** Every account YAML in `dir`, validated against the AccountRules schema, sorted by id. Throws with the file name on a bad file. */
export function loadAccounts(dir: string = ACCOUNTS_DIR): AccountRules[] {
  const out: AccountRules[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const res = AccountRules.safeParse(parse(readFileSync(join(dir, file), 'utf8')));
    if (!res.success) throw new Error(`accounts/${file}: ${res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    if (`${res.data.id}.yaml` !== file) throw new Error(`accounts/${file}: id "${res.data.id}" does not match the file name`);
    out.push(res.data);
  }
  return out;
}
