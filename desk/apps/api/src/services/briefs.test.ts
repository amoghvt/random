import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, KV, MIN, fromZoned, type Profile } from '@desk/contracts';
import { bias } from '@desk/engines';
import { runLoop } from '../worker';
import { storedWeights, type WeightProposal } from './bias';
import { approveMemo, generateMorning, generateRecap, generateWeekly, latestBrief, regenerateMorning, runDueBriefs } from './briefs';
import { profileOf } from './context';
import { offer } from './notify';
import { desk, recordedDesk } from './recorded.testkit';

const et = (d: number, h: number, m: number): number => fromZoned(2026, 11, d, h, m);

describe('briefs service', () => {
  it('06:30 morning brief has all seven sections from the stored state, every number stamped, and releases what quiet hours held', async () => {
    const at = et(17, 6, 30);
    const d = await recordedDesk(at);
    await runLoop(d.deps, at - 5 * MIN);
    // Held overnight by quiet hours (a test line, no market number in it).
    await offer(d.deps, { class: 'P1', reason: 'test_reason', instrument: 'NQ', lines: ['Held overnight test line.'], deepLink: '/journal', dedupeKey: 'held:1', ts: new Date(et(17, 2, 0)).toISOString() }, et(17, 2, 0));
    const run = await generateMorning(d.deps, at);
    const b = run.brief;
    expect(b.kind).toBe('morning');
    expect(b.forDay).toBe('2026-11-17');
    expect(b.sections.map((s) => s.title)).toEqual(['The call', 'Overnight', 'Catalysts today', 'Positions and tickets', 'Accounts', 'The one thing', 'Reads worth two minutes']);
    for (const s of b.sections) console.log(`[brief] ${s.title}: ${s.lines[0]}`);
    expect(b.sections[0]!.lines[0]).toMatch(/^NQ intraday: (Strong|Lean|No edge)/);
    expect(b.sections[1]!.lines.join(' ')).toContain('10Y');
    expect(b.sections[2]!.lines.join(' ')).toContain('Retail Sales');
    expect(JSON.stringify(b)).toContain('Held overnight test line.');
    expect(run.intent).toMatchObject({ class: 'P3', reason: 'brief_morning', deepLink: `/journal?brief=${b.id}` });
    expect((await latestBrief(d.deps, 'morning'))?.id).toBe(b.id);

    // 08:00 ET with nothing new: the brief already sent stands.
    const same = await regenerateMorning(d.deps, at + MIN);
    expect(same.replaced).toBe(false);
    expect(same.brief.id).toBe(b.id);
    expect(await d.store.list('briefs', { status: 'morning' })).toHaveLength(1);
  }, 120_000);

  it('08:00 ET regeneration replaces the brief after the 08:30-style change: here the real Nov 17 loop moving the call', async () => {
    const at = et(17, 6, 30);
    const d = await recordedDesk(at);
    await runLoop(d.deps, at - 5 * MIN);
    const first = await generateMorning(d.deps, at);
    d.clock.t = et(17, 8, 0);
    await runLoop(d.deps, d.clock.t);
    const regen = await regenerateMorning(d.deps, d.clock.t);
    console.log(`[brief] 08:00 ET regeneration replaced=${regen.replaced}; call line now: ${regen.brief.sections[0]!.lines[0]}`);
    const stored = await d.store.list('briefs', { status: 'morning' });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(regen.brief.id);
    if (regen.replaced) expect(regen.brief.sections[0]!.lines).not.toEqual(first.brief.sections[0]!.lines);
  }, 120_000);

  it('recap on the real Nov 10 2026 session reports the CPI print against consensus', async () => {
    const at = et(10, 16, 30);
    const d = await recordedDesk(at);
    await runLoop(d.deps, at - MIN);
    const run = await generateRecap(d.deps, at);
    const lines = run.brief.sections.flatMap((s) => s.lines);
    console.log(`[brief] recap: ${run.brief.sections.find((s) => s.title === 'What happened')?.lines.join(' / ')}`);
    expect(run.brief.sections.map((s) => s.title)).toEqual(['The call', 'What happened', 'Right or wrong', 'Plan adherence', 'Override ledger', 'Tomorrow']);
    expect(lines).toContain('CPI (core MoM): 0.3% vs consensus 0.2%.');
    expect(lines).toContain('No closed trades today. No adherence score.');
    expect(run.intent?.reason).toBe('brief_recap');
  }, 120_000);

  it('weekly: the memo is stored on the profile as a proposal, and re-fitted weights apply only when it is approved', async () => {
    const at = et(15, 18, 0);
    const d = await recordedDesk(at, { symbols: ['NQ'], tfs: ['1d'] });
    const profile = await profileOf(d.deps);
    const before = await storedWeights(d.deps, profile);
    // A pending re-fit (weights typed in by the test) waiting on the memo.
    const proposed = bias.normaliseWeights({ ...DEFAULT_WEIGHTS, news: DEFAULT_WEIGHTS.news / 2 });
    const report: bias.RefitReport = { refit: true, n: 60, reason: 'test proposal', hitRate: null, moved: [], lines: [] };
    await d.store.kvSet<WeightProposal>(KV.proposedWeights, { proposedAt: new Date(at).toISOString(), from: before, weights: proposed, report, approved: false });

    const run = await generateWeekly(d.deps, at);
    expect(run.brief.kind).toBe('weekly');
    expect(run.brief.sections.length).toBe(6);
    expect(run.memo.approved).toBe(false);
    const stored = (await d.store.kvGet<Profile>(KV.profile))!;
    expect(stored.memos.filter((m) => m.week === run.memo.week)).toEqual([run.memo]);
    expect(await storedWeights(d.deps, profile)).toEqual(before);
    console.log(`[brief] weekly memo ${run.memo.week}: ${run.memo.text.split('\n')[0]}`);

    expect(await approveMemo(d.deps, 'no-such-week')).toBeNull();
    const approved = await approveMemo(d.deps, run.memo.week, 'Edited by the trader.');
    expect(approved).toMatchObject({ approved: true, text: 'Edited by the trader.' });
    expect(await storedWeights(d.deps, profile)).toEqual(proposed);
    // A second weekly run in the same week leaves the approved memo alone.
    await generateWeekly(d.deps, at + MIN);
    expect((await d.store.kvGet<Profile>(KV.profile))!.memos.find((m) => m.week === run.memo.week)).toEqual(approved);
  }, 60_000);

  it('runDueBriefs runs each slot once, and does not catch up a slot missed by more than its window', async () => {
    // A fresh desk on a Tuesday morning: last Sunday's weekly slot is two days gone and is not written late.
    const d = await desk(et(17, 6, 0));
    expect((await runDueBriefs(d.deps, et(17, 6, 0))).briefs).toEqual([]);
    const due = await runDueBriefs(d.deps, et(17, 6, 31));
    expect(due.briefs.map((x) => x.kind)).toEqual(['morning']);
    expect(due.intents.map((i) => i.reason)).toEqual(['brief_morning']);
    expect((await runDueBriefs(d.deps, et(17, 6, 40))).briefs).toEqual([]);
    const recap = await runDueBriefs(d.deps, et(17, 16, 31));
    expect(recap.briefs.map((x) => x.kind)).toEqual(['recap']);
    expect((await runDueBriefs(d.deps, et(17, 16, 45))).briefs).toEqual([]);
    // Sunday 18:00 local: the weekly, once.
    expect((await runDueBriefs(d.deps, et(22, 18, 1))).briefs.map((x) => x.kind)).toEqual(['weekly']);
    expect((await runDueBriefs(d.deps, et(22, 18, 20))).briefs).toEqual([]);
    // A desk first started at 23:00 writes no morning brief for a morning that is long over.
    const late = await desk(et(17, 23, 0));
    expect((await runDueBriefs(late.deps, et(17, 23, 0))).briefs).toEqual([]);
  });
});
