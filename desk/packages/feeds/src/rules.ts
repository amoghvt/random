/**
 * Firm-rule scraper and nightly diff (spec sections 4 and 7).
 * Each URL in an account's `source.urls` is fetched, reduced to its rule sentences and compared with the
 * previous snapshot in kv `rules.snapshot.<accountId>`. A changed sentence yields a RuleDiff (the caller
 * raises the P0); whitespace, markup and date-stamp noise do not. A page that cannot be fetched (bot
 * protection) is recorded as a failure on the snapshot and in feed health, and never produces a diff.
 */
import { KV, hashId, iso, type AccountRules, type RuleDiff, type Store } from '@desk/contracts';
import { HttpError, httpText } from './http';
import type { FetchLike } from './types';

export interface RulePage { url: string; ok: boolean; status: number | null; html: string; error: string | null }
export interface RuleSnapshotEntry { url: string; sentences: string[]; hash: string; fetchedAt: string; ok: boolean; error: string | null }
export type RuleSnapshot = Record<string, RuleSnapshotEntry>;

const BLOCKED = /<title>\s*(just a moment|attention required|access denied|verify you are human)|cf-challenge|challenge-platform/i;

/** Never throws: a blocked or failed page comes back with `ok: false` and the reason. */
export async function fetchRulePage(url: string, fetch?: FetchLike): Promise<RulePage> {
  try {
    const html = await httpText(url, { fetch, timeoutMs: 20_000, headers: { Accept: 'text/html,application/xhtml+xml' } });
    if (BLOCKED.test(html.slice(0, 4000))) return { url, ok: false, status: 200, html: '', error: 'bot protection challenge page' };
    return { url, ok: true, status: 200, html, error: null };
  } catch (e) {
    const status = e instanceof HttpError ? e.status : null;
    const blocked = status === 403 || status === 429 || status === 503;
    return { url, ok: false, status, html: '', error: blocked ? `HTTP ${status} (bot protection)` : e instanceof Error ? e.message : String(e) };
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
const decode = (s: string): string => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** "Updated over a week ago", "Last updated: Nov 3, 2026", "© 2026", bare dates: page furniture, not rules. */
const DATE_NOISE = new RegExp([
  String.raw`^(last )?(updated|modified|published|written by|effective)\b.{0,60}$`,
  String.raw`^(updated|published) .*\b(ago|today|yesterday)\b.*$`,
  String.raw`^©.*$|^copyright\b.*$`,
  String.raw`^${MONTH}\.? \d{1,2},? \d{4}$`, String.raw`^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$`, String.raw`^\d{4}-\d{2}-\d{2}.*$`,
].join('|'), 'i');
const BOILERPLATE = /^(skip to main content|table of contents|related articles|did this answer your question\??|search for articles\.{0,3}|all collections|english|back to top|cookie(s| settings| policy)?|accept( all)?|privacy policy|terms of (service|use)|contact( us)?|log ?in|sign ?up|get started|we run on intercom|powered by .*)$/i;

/**
 * HTML -> ordered, de-duplicated rule sentences. Drops script/style/nav/header/footer/forms, prefers the
 * <article> or <main> body when the page has one, and removes date stamps and help-center furniture.
 */
export function normalizeRuleText(html: string): string[] {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|nav|header|footer|form|button|select|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const body = /<article\b[\s\S]*<\/article>/i.exec(h) ?? /<main\b[\s\S]*<\/main>/i.exec(h);
  if (body) h = body[0];
  // Source line breaks are layout, not structure: only block tags end a line.
  const text = decode(h.replace(/\s+/g, ' ').replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th|\/section|\/blockquote)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of text.split('\n')) {
    for (const raw of block.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)) {
      const s = raw.replace(/[\u00a0\u200b\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
      if (s.length < 8 || !/[a-z]/i.test(s) || DATE_NOISE.test(s) || BOILERPLATE.test(s)) continue;
      const key = ruleKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/** Comparison key: case, punctuation spacing and typographic quotes do not make a sentence "changed". */
function ruleKey(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/\s*([.,;:!?])\s*/g, '$1').trim();
}

export function diffRules(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  const p = new Set(prev.map(ruleKey)), n = new Set(next.map(ruleKey));
  return { added: next.filter((s) => !p.has(ruleKey(s))), removed: prev.filter((s) => !n.has(ruleKey(s))) };
}

const clip = (s: string, n = 110): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Snapshot every rule page of every account and return a RuleDiff per changed page (one per URL, listing all
 * accounts that cite it). The first successful snapshot of a page is the baseline and raises nothing.
 * Failures are written to kv `feeds.health` as `rules:<host>`.
 */
export async function checkFirmRules(store: Store, accounts: AccountRules[], now: number, fetch?: FetchLike): Promise<RuleDiff[]> {
  const byUrl = new Map<string, AccountRules[]>();
  for (const a of accounts) for (const url of a.source.urls) byUrl.set(url, [...(byUrl.get(url) ?? []), a]);
  const snapshots = new Map<string, RuleSnapshot>();
  for (const a of accounts) snapshots.set(a.id, (await store.kvGet<RuleSnapshot>(KV.ruleSnapshot(a.id))) ?? {});

  const diffs: RuleDiff[] = [];
  const health = new Map<string, { ok: boolean; error: string | null }>();
  const fetchedAt = iso(now);
  for (const [url, accts] of byUrl) {
    const page = await fetchRulePage(url, fetch);
    const sentences = page.ok ? normalizeRuleText(page.html) : [];
    // A client-rendered page leaves a line or two of shell text: not a rule page we can diff.
    const usable = page.ok && sentences.length >= 3;
    const error = usable ? null : page.error ?? 'no rule text in the HTML (client-rendered page)';
    const host = `rules:${new URL(url).host}`;
    const h = health.get(host);
    health.set(host, { ok: (h?.ok ?? true) && usable, error: h?.error ?? (usable ? null : `${error} (${url})`) });

    let diff: { added: string[]; removed: string[] } | null = null;
    for (const a of accts) {
      const snap = snapshots.get(a.id) as RuleSnapshot;
      const prev = snap[url];
      if (!usable) { snap[url] = { url, sentences: prev?.sentences ?? [], hash: prev?.hash ?? '', fetchedAt, ok: false, error }; continue; }
      if (prev && prev.sentences.length > 0 && !diff) {
        const d = diffRules(prev.sentences, sentences);
        if (d.added.length || d.removed.length) diff = d;
      }
      snap[url] = { url, sentences, hash: hashId('rules', ...sentences.map(ruleKey)), fetchedAt, ok: true, error: null };
    }
    if (diff) {
      const first = diff.added[0] ?? diff.removed[0] ?? '';
      diffs.push({
        id: hashId('rulediff', url, fetchedAt.slice(0, 10), ...diff.added, ...diff.removed), accountIds: accts.map((a) => a.id), firm: accts[0]!.firm, url, detectedAt: fetchedAt,
        summary: `${accts[0]!.firm} rule page changed: ${diff.added.length} added, ${diff.removed.length} removed. ${diff.added[0] ? 'New' : 'Removed'}: "${clip(first)}"`,
        added: diff.added, removed: diff.removed,
      });
    }
  }
  for (const [id, snap] of snapshots) await store.kvSet(KV.ruleSnapshot(id), snap);
  if (diffs.length) await store.put('rule_diffs', diffs);

  const all = (await store.kvGet<FeedHealthRow[]>(KV.feedHealth)) ?? [];
  for (const [feed, h] of health) {
    const prev = all.find((r) => r.feed === feed);
    const row: FeedHealthRow = { feed, ok: h.ok, lastOk: h.ok ? fetchedAt : prev?.lastOk ?? null, error: h.error, live: false, lastPoll: fetchedAt };
    if (prev) Object.assign(prev, row); else all.push(row);
  }
  await store.kvSet(KV.feedHealth, all);
  return diffs;
}

/** Row shape of kv `feeds.health` (NowView.feedHealth plus the last poll time used for scheduling). */
export interface FeedHealthRow { feed: string; ok: boolean; lastOk: string | null; error: string | null; live: boolean; lastPoll?: string }
