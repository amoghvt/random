import { describe, expect, it } from 'vitest';
import { HOUR, KV, MIN, fromZoned, iso } from '@desk/contracts';
import { runLoop } from '../worker';
import { testTicket } from './journal.testkit';
import { answerFromMemory, memoryIndex, searchMemory } from './memory';
import { desk, recordedDesk } from './recorded.testkit';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);

describe('memory service', () => {
  it('indexes the journal, keeps the stored index until the journal changes, and rebuilds when it does', async () => {
    const now = et(17, 11, 0);
    const d = await desk(now);
    expect(await searchMemory(d.deps, 'anything', now)).toEqual([]);
    await d.store.put('tickets', [testTicket('tkt_mem', 27_000, now, { notes: 'Faded the retail sales spike into the 50 EMA.' })]);
    const hits = await searchMemory(d.deps, 'retail sales spike', now);
    expect(hits[0]).toMatchObject({ id: 'tkt_mem', kind: 'trade', source: 'journal:trade' });
    const built = (await d.store.kvGet<{ signature: string; builtAt: string }>(KV.memoryIndex))!;
    expect(built.builtAt).toBe(iso(now));

    // Nothing changed: the stored index is reused as is.
    await memoryIndex(d.deps, now + HOUR);
    expect((await d.store.kvGet<{ builtAt: string }>(KV.memoryIndex))!.builtAt).toBe(iso(now));

    await d.store.put('notes', [{ id: 'note_1', ts: iso(now + 30 * MIN), text: 'Gold on RSI at midnight is not a catalyst.', tags: [], source: 'trader' }]);
    const gold = await searchMemory(d.deps, 'gold RSI midnight', now + HOUR);
    expect(gold[0]).toMatchObject({ id: 'note_1', kind: 'note' });
    const rebuilt = (await d.store.kvGet<{ signature: string; builtAt: string }>(KV.memoryIndex))!;
    expect(rebuilt.builtAt).toBe(iso(now + HOUR));
    expect(rebuilt.signature).not.toBe(built.signature);
    // A record stamped after `now` is not a memory yet.
    expect(await searchMemory(d.deps, 'gold RSI midnight', now)).toEqual([]);
  });

  it('after the real Nov 10 2026 CPI the resolved catalyst is searchable with its numbers', async () => {
    const eve = et(9, 20, 5);
    const d = await recordedDesk(eve);
    for (const t of [eve, et(10, 8, 29), et(10, 8, 31), et(10, 8, 46)]) { d.clock.t = t; await runLoop(d.deps, t); }
    const now = et(10, 9, 0);
    const hits = await searchMemory(d.deps, 'CPI hot core', now, { k: 3 });
    console.log(`[memory] ${hits[0]?.text}`);
    expect(hits[0]).toMatchObject({ kind: 'event', source: 'journal:catalyst' });
    expect(hits[0]!.text).toContain('consensus 0.2, prior 0.3, actual 0.3');
    // No trade was taken: a question about trades has no sample and says so.
    const answer = await answerFromMemory(d.deps, 'last 2 NQ trades', now);
    expect(answer.matches).toEqual([]);
    expect(answer.text).toContain('Nothing on record matches. No sample, no answer.');
  }, 120_000);
});
