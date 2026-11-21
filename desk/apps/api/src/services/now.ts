/** The Now screen's view, assembled from what the engines wrote. Nothing here computes a call or a size. */
import { CORE_SYMBOLS, DAY, KV, iso, type NowView } from '@desk/contracts';
import { currentCalls } from './bias';
import { nextCatalyst } from './catalysts';
import { killSwitchOn, profileOf, readOnlyState, type DeskDeps, type HealthRow } from './context';
import { priceSymbolOf, quotesView, ratesStrip } from './market';
import { inQuietHours } from './notify';

export async function nowView(deps: DeskDeps, now: number): Promise<NowView> {
  const profile = await profileOf(deps);
  const primary = profile.instruments.primary[0] ?? 'NQ';
  const symbols = [...new Set([...CORE_SYMBOLS, ...profile.instruments.watchlist, ...profile.instruments.occasional].map(priceSymbolOf))];
  const [calls, updates, rates, quotes, next, headlines, kill, readOnly, quiet, health] = await Promise.all([
    currentCalls(deps, now),
    deps.store.list('watcher_updates', { since: iso(now - DAY), until: iso(now + 1), limit: 30 }),
    ratesStrip(deps, now), quotesView(deps, now, symbols), nextCatalyst(deps, now),
    deps.store.list('headlines', { since: iso(now - DAY), until: iso(now + 1), limit: 30 }),
    killSwitchOn(deps.store), readOnlyState(deps.store, now), inQuietHours(deps, now),
    deps.store.kvGet<HealthRow[]>(KV.feedHealth),
  ]);
  return {
    asOf: iso(now),
    primary: calls.find((c) => c.instrument === primary && c.horizon === 'intraday') ?? null,
    calls, updates, rates, quotes,
    nextCatalyst: next ? { id: next.id, name: next.name, tier: next.tier, scheduledAt: next.scheduledAt, consensus: next.consensus, prior: next.prior, ...(next.unit ? { unit: next.unit } : {}) } : null,
    headlines,
    session: { killSwitch: kill, readOnly: readOnly.readOnly, readOnlyReason: readOnly.reason, quietHours: quiet },
    feedHealth: health ?? [],
  };
}
