/** The Journal screen: adherence first, then calibration with where its calls came from, the ledger and the four record lists. */
import { DAY, hashId, iso, type JournalNote, type JournalView } from '@desk/contracts';
import { guardrails as g, tickets as tk } from '@desk/engines';
import { computeCalibration } from './bias';
import type { DeskDeps } from './context';
import { ledgerOf } from './tickets';

const LIST_LIMIT = 200;

export async function journalView(deps: DeskDeps, now: number): Promise<JournalView> {
  const until = iso(now + 1);
  const [tickets, calls, firings, notes, baseRates, calibration, ledger] = await Promise.all([
    deps.store.list('tickets', { since: iso(now - 400 * DAY), until }),
    deps.store.list('bias_calls', { since: iso(now - 120 * DAY), until, limit: LIST_LIMIT }),
    deps.store.list('guardrail_firings', { since: iso(now - 150 * DAY), until }),
    deps.store.list('notes', { until, limit: LIST_LIMIT }),
    deps.store.list('base_rates'),
    computeCalibration(deps, now), ledgerOf(deps, now),
  ]);
  const rolling = tk.rollingAdherence(tickets, 20);
  const table = calibration.table;
  return {
    asOf: iso(now),
    adherence20: rolling.score, adherenceCount: rolling.count, pnl20Usd: rolling.pnlUsd,
    calibration: { buckets: table.buckets, n: table.n, updatedAt: table.n > 0 ? table.updatedAt : null, source: table.source },
    ledger,
    trades: tickets.slice(0, LIST_LIMIT), calls, events: firings.slice(0, LIST_LIMIT), notes,
    baseRates: baseRates.sort((a, b) => a.instrument.localeCompare(b.instrument) || a.pattern.localeCompare(b.pattern) || a.tf.localeCompare(b.tf)),
    guardrailScorecard: g.scorecard(firings, now).map((r) => ({ pattern: r.pattern, fired: r.fired, complied: r.complied, overrode: r.overrode, savedUsd: r.savedUsd, costUsd: r.costUsd, retired: r.retired })),
  };
}

/** A note in the trader's own words. Tags are lower-cased and deduplicated. */
export async function addNote(deps: DeskDeps, text: string, tags: string[], now: number): Promise<JournalNote> {
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  const body = text.trim();
  const note: JournalNote = { id: hashId('note', now, body), ts: iso(now), text: body, tags: clean, source: 'trader' };
  await deps.store.put('notes', [note]);
  return note;
}
