/**
 * Live smoke test of the free feed stack: one forced ingest into an in-memory store, then the rule pages.
 * Run: `NODE_USE_ENV_PROXY=1 npx tsx packages/feeds/scripts/smoke.ts` (the env var is only needed behind an
 * HTTPS proxy; Node >= 22.21 then routes global fetch through HTTPS_PROXY with the system CA bundle).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AccountRules, CORE_SYMBOLS, DATUM_KEYS, DAY, DEFAULT_WATCHLIST, HOUR, KV } from '@desk/contracts';
import { TIER1_CODES, buildFeeds, checkFirmRules, ingestOnce, lagText, stamped, type FeedHealthRow } from '../src/index';
import { FakeStore } from '../src/testing';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const now = Date.now();
const store = new FakeStore();
const env = { ...process.env, ANTHROPIC_API_KEY: process.env.SMOKE_LLM === '1' ? process.env.ANTHROPIC_API_KEY : undefined };
const feeds = buildFeeds(env);
const symbols = [...new Set([...CORE_SYMBOLS, 'MNQ', 'VIX3M', 'US3M', 'US5Y', 'NDX', 'QQQ', 'CL', 'GC', 'BTC', 'ETH', 'ZQ', ...DEFAULT_WATCHLIST])];

console.log(`now ${new Date(now).toISOString()}  feeds enabled: ${feeds.all.map((f) => f.name).join(', ')}\n`);
const report = await ingestOnce(store, feeds, now, { env, symbols, force: true });
for (const p of report.polled) console.log(`${p.ok ? 'ok  ' : 'FAIL'} ${p.feed.padEnd(24)} items=${String(p.items).padStart(5)} ${String(p.ms).padStart(5)}ms ${p.error ?? ''}`);
console.log('written', JSON.stringify(report.written), '\n');

const quotes = await store.latestQuotes();
for (const s of ['NQ', 'ES', 'VIX', 'DXY', 'NVDA', 'BTC']) { const q = quotes[s]; if (q) { const st = stamped({ value: q.price, ...q }, now); console.log(`quote ${s.padEnd(5)} ${q.price}  ${q.changePct?.toFixed(2)}%  src=${q.source} age=${st.age} stale=${st.stale}`); } }
console.log(`quotes stored: ${Object.keys(quotes).length}/${symbols.length}; missing: ${symbols.filter((s) => !quotes[s]).join(',') || 'none'}`);

for (const k of ['US2Y', 'US10Y', 'US30Y'] as const) {
  const d = await store.latestDatum(DATUM_KEYS.rate(k));
  if (!d) { console.log(`rate ${k}: missing`); continue; }
  const hist = await store.dataHistory(d.key, Date.parse(d.asOf) - 26 * HOUR);
  const ref = hist.filter((h) => Date.parse(h.asOf) <= Date.parse(d.asOf) - HOUR).at(-1);
  console.log(`rate ${k} ${d.value}%  src=${d.source} asOf=${d.asOf} age=${stamped(d, now).age} history=${hist.length} pts  1h chg=${ref ? `${((d.value - ref.value) * 100).toFixed(1)} bp (vs ${ref.value} @ ${ref.asOf}, ${ref.source})` : 'n/a'}`);
}
const d2s10s = await store.latestDatum(DATUM_KEYS.spread2s10s);
console.log(`2s10s ${d2s10s?.value} bp`);
const fed = await store.latestData([DATUM_KEYS.fedHike, DATUM_KEYS.fedCut, DATUM_KEYS.fedHold, DATUM_KEYS.fedImplied]);
console.log(`fed  hike=${fed[DATUM_KEYS.fedHike]?.value} cut=${fed[DATUM_KEYS.fedCut]?.value} hold=${fed[DATUM_KEYS.fedHold]?.value} implied=${fed[DATUM_KEYS.fedImplied]?.value}  meta=${JSON.stringify(fed[DATUM_KEYS.fedHike]?.meta)}`);
const vol = await store.latestData([DATUM_KEYS.vix, DATUM_KEYS.vix3m, DATUM_KEYS.vixTerm]);
console.log(`vol  VIX=${vol[DATUM_KEYS.vix]?.value} VIX3M=${vol[DATUM_KEYS.vix3m]?.value} term=${vol[DATUM_KEYS.vixTerm]?.value}`);
for (const s of ['NQ', 'NVDA']) { const m = await store.latestDatum(DATUM_KEYS.impliedMove(s)), pc = await store.latestDatum(DATUM_KEYS.putCall(s)); console.log(`implied move ${s}: ${m?.value}%  ${JSON.stringify(m?.meta)}  put/call=${pc?.value}`); }

const cal = await store.list('calendar', { since: new Date(now - DAY).toISOString(), until: new Date(now + 8 * DAY).toISOString(), order: 'asc' });
console.log(`\ncalendar next 8 days: ${cal.length} rows, coded: ${cal.filter((e) => e.code !== 'OTHER').length}`);
for (const e of cal.filter((x) => x.code !== 'OTHER' && x.code !== 'TREASURY_AUCTION')) console.log(`  ${e.time.slice(0, 16)}Z ${e.code.padEnd(12)} ${e.name}  consensus=${e.consensus} prior=${e.prior} actual=${e.actual} ${e.unit ?? ''}`);
const all = await store.list('calendar', { order: 'asc' });
for (const e of all.filter((x) => TIER1_CODES.includes(x.code) && Date.parse(x.time) > now).slice(0, 8)) console.log(`  tier1 ${e.time.slice(0, 16)}Z ${e.code.padEnd(9)} ${e.name} consensus=${e.consensus} prior=${e.prior}`);

const heads = await store.list('headlines', { limit: 500 });
console.log(`\nheadlines: ${heads.length}; by impact ${[0, 1, 2, 3].map((i) => `${i}:${heads.filter((h) => h.impact === i).length}`).join(' ')}; classifier=${heads[0]?.classifier}`);
for (const h of heads.filter((x) => x.impact >= 2).slice(0, 8)) console.log(`  [${h.impact}|${h.direction}|${h.category}] ${h.title.slice(0, 110)} {${h.symbols.join(',')}}`);

const preds = await store.list('predictions', { limit: 200 });
console.log(`\npredictions: ${preds.length}`);
for (const p of preds.filter((x) => x.eventCode === 'FOMC' || x.eventCode === 'CPI').slice(0, 6)) console.log(`  ${p.venue} ${p.eventCode} ${p.eventDate} "${p.title}" ${p.outcomes.filter((o) => o.prob >= 0.03).map((o) => `${o.label}=${o.prob}`).join(' | ').slice(0, 170)}`);

const earn = await store.list('earnings', { order: 'asc' });
console.log(`\nearnings: ${earn.length}`);
for (const e of earn) console.log(`  ${e.symbol.padEnd(5)} ${e.date.slice(0, 10)} ${e.timing} eps=${e.epsConsensus} implied=${e.impliedMovePct} history=${e.history.map((h) => `${h.date}:${h.nextDayPct}%`).join(' ')}`);
for (const f of await store.list('lagged_facts')) console.log(`\nlagged: ${f.text}`);
console.log(`lagText sample: ${lagText('2026-09-30', now)}`);

const accounts = readdirSync(join(root, 'accounts')).filter((f) => f.endsWith('.yaml')).flatMap((f) => { const r = AccountRules.safeParse(parse(readFileSync(join(root, 'accounts', f), 'utf8'))); return r.success ? [r.data] : []; });
console.log(`\nrule pages for ${accounts.length} accounts`);
const diffs = await checkFirmRules(store, accounts, now);
const snaps = new Map<string, { ok: boolean; n: number; error: string | null }>();
for (const a of accounts) for (const s of Object.values((await store.kvGet<Record<string, { url: string; ok: boolean; sentences: string[]; error: string | null }>>(KV.ruleSnapshot(a.id))) ?? {})) snaps.set(s.url, { ok: s.ok, n: s.sentences.length, error: s.error });
for (const [url, s] of snaps) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${url}  sentences=${s.n} ${s.error ?? ''}`);
console.log(`first-run diffs (must be 0): ${diffs.length}`);
const health = (await store.kvGet<FeedHealthRow[]>(KV.feedHealth)) ?? [];
console.log(`health rows: ${health.length}, failing: ${health.filter((h) => !h.ok).map((h) => h.feed).join(', ') || 'none'}`);
