/** Test-only journal records. These are the trader's side of the story (tickets, fills), typed in by the test; prices in them are chosen relative to recorded marks. */
import { iso, type Ticket } from '@desk/contracts';

/** A ticket as the trader would have saved it: three targets and an invalidation around `entry`, one entry fill, still open. */
export function testTicket(id: string, entry: number, now: number, over: Partial<Ticket> = {}): Ticket {
  const long = (over.direction ?? 'long') === 'long';
  const d = long ? 1 : -1;
  return {
    id, createdAt: iso(now - 3 * 3_600_000), accountId: 'lucid-25k', instrument: 'MNQ', direction: long ? 'long' : 'short',
    reason: { kind: 'structure', setupEventId: 'se_test' }, entry: { kind: 'price', text: `reclaim of ${entry}`, price: entry },
    size: { engineMaxUnits: 1, units: 1, notionalUsd: 2 * entry, leverage: null, failPrice: entry - d * 600 },
    targets: [{ price: entry + d * 60, fraction: 1 / 3 }, { price: entry + d * 120, fraction: 1 / 3 }, { price: entry + d * 200, fraction: 1 / 3 }],
    invalidation: { price: entry - d * 80, reason: 'loses the reclaimed level' }, timeStop: iso(now + 4 * 3_600_000),
    holdThroughCatalyst: { flag: false, catalystId: null }, status: 'open',
    fills: [{ ts: iso(now - 2 * 3_600_000), price: entry, units: 1, kind: 'entry', source: 'manual' }],
    overrides: [], watcherEventIds: [], closedAt: null, result: null, sizingSnapshot: null, ...over,
  };
}
