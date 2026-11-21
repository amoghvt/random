/** Memory layer: a TF-IDF index over the journal and the chat, kept in kv and rebuilt only when the journal changed. */
import { DAY, KV, hashId, iso, type MemoryHit } from '@desk/contracts';
import { tickets as tk } from '@desk/engines';
import type { DeskDeps } from './context';

interface StoredIndex { signature: string; builtAt: string; index: tk.MemoryIndex }
const HORIZON_MS = 730 * DAY;

async function sources(deps: DeskDeps, now: number): Promise<tk.MemorySources> {
  const since = iso(now - HORIZON_MS), until = iso(now + 1);
  const [tickets, calls, firings, notes, chat, catalysts] = await Promise.all([
    deps.store.list('tickets', { since, until }), deps.store.list('bias_calls', { since, until }), deps.store.list('guardrail_firings', { since, until }),
    deps.store.list('notes', { since, until }), deps.store.list('chat', { since, until }),
    // Past catalysts only: an upcoming one is a plan, not a memory.
    deps.store.list('catalysts', { since, until, status: 'resolved' }),
  ]);
  return { tickets, calls, firings, notes, chat, catalysts };
}

/** The index as of `now`. Rebuilt when any journal record was added or changed since the stored one was built. */
export async function memoryIndex(deps: DeskDeps, now: number): Promise<tk.MemoryIndex> {
  const docs = tk.toMemoryDocs(await sources(deps, now));
  const signature = hashId('mem', docs.length, ...docs.map((d) => hashId('d', d.id, d.text)));
  const stored = await deps.store.kvGet<StoredIndex>(KV.memoryIndex);
  if (stored && stored.signature === signature) return stored.index;
  const index = tk.buildIndex(docs);
  await deps.store.kvSet<StoredIndex>(KV.memoryIndex, { signature, builtAt: iso(now), index });
  return index;
}

const hitOf = (h: tk.MemoryHit): MemoryHit => ({
  id: h.doc.ref, kind: h.doc.kind === 'catalyst' ? 'event' : h.doc.kind, ts: h.doc.ts, text: h.doc.text, score: h.score, source: `journal:${h.doc.kind}`,
});

/** Free-text search with optional structured filters, in the shape the briefs and Ask take. */
export async function searchMemory(deps: DeskDeps, query: string, now: number, opts: { k?: number; filters?: tk.MemoryFilters } = {}): Promise<MemoryHit[]> {
  return tk.search(await memoryIndex(deps, now), query, opts).map(hitOf);
}

/** A journal question answered from the records themselves ("the last three times I held through earnings"). */
export async function answerFromMemory(deps: DeskDeps, question: string, now: number, opts: { k?: number } = {}): Promise<tk.MemoryAnswer> {
  return tk.answerFromMemory(await memoryIndex(deps, now), question, opts);
}
