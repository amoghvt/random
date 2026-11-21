/** Chart watcher over the store: detectors per symbol, new StructureEvents, at most one WatcherUpdate per symbol per tick, daily base rates. */
import { CORE_SYMBOLS, DAY, HOUR, KV, TF_MS, iso, type BiasCall, type Candle, type NotificationIntent, type StructureEvent, type Timeframe, type WatcherUpdate } from '@desk/contracts';
import { notify, watcher as w } from '@desk/engines';
import { profileOf, type DeskDeps } from './context';
import { candleReader, lastPrice, priceSymbolOf, TFS, type CandleReader } from './market';

/** Compared against the instrument on 15m: ES and SOX for rotation, the 10Y for index-versus-yields. */
const PEERS: Record<string, string[]> = { NQ: ['ES', 'SOX', 'US10Y'], ES: ['NQ'] };
const PEER_TF: Timeframe = '15m';
const SCAN: Record<Timeframe, number> = { '1m': 600, '5m': 600, '15m': 600, '1h': 600, '1d': 400 };
/** A setup first seen long after its candle (a backfill landed) is history, not a push. */
const FRESH_SETUP_MS = 30 * 60_000;

export async function watchedSymbols(deps: DeskDeps): Promise<string[]> {
  const profile = await profileOf(deps);
  return [...new Set([...CORE_SYMBOLS, ...profile.instruments.watchlist].map(priceSymbolOf))];
}

export interface WatcherStep { events: StructureEvent[]; updates: WatcherUpdate[]; intents: NotificationIntent[]; symbols: number }

/** One watcher tick. Symbols with no candles in the store are skipped. */
export async function runWatcher(deps: DeskDeps, now: number, reader: CandleReader = candleReader(deps, now)): Promise<WatcherStep> {
  const profile = await profileOf(deps);
  const primary = profile.instruments.primary.map(priceSymbolOf);
  const out: WatcherStep = { events: [], updates: [], intents: [], symbols: 0 };
  const [positions, tickets] = await Promise.all([deps.store.list('positions'), deps.store.list('tickets', { status: ['open', 'planned'] })]);

  for (const symbol of await watchedSymbols(deps)) {
    const candles: Partial<Record<Timeframe, Candle[]>> = {};
    for (const tf of TFS) { const cs = await reader.get(symbol, tf, SCAN[tf]); if (cs.length) candles[tf] = cs; }
    if (Object.keys(candles).length === 0) continue;
    out.symbols++;
    const peers: Record<string, Candle[]> = {};
    if (candles[PEER_TF]) for (const p of PEERS[symbol] ?? []) { const cs = await reader.get(p, PEER_TF, SCAN[PEER_TF]); if (cs.length) peers[p] = cs; }
    const baseRates = await deps.store.list('base_rates', { instrument: symbol });
    const all = w.runDetectors({ instrument: symbol, candles, peers, now, baseRates });
    const prev = await deps.store.kvGet<w.WatcherState>(KV.watcherState(symbol));
    const fresh = w.diffEvents(prev, all);
    if (fresh.length) await deps.store.put('structure_events', fresh);
    out.events.push(...fresh);

    const mine = (instrument: string): boolean => priceSymbolOf(instrument) === symbol;
    const open = tickets.filter((t) => mine(t.instrument));
    const live = open.filter((t) => t.status === 'open');
    if (fresh.length && live.length) {
      await deps.store.put('tickets', live.map((t) => ({ ...t, watcherEventIds: [...new Set([...t.watcherEventIds, ...fresh.map((e) => e.id)])].slice(-200) })));
    }

    const price = await lastPrice(deps, symbol, now, reader);
    let state: w.WatcherState = { eventIds: [...new Set([...(prev?.eventIds ?? []), ...all.map((e) => e.id)])].slice(-5000), observations: prev?.observations ?? {} };
    // The first run on a symbol is the baseline: everything on the chart is "new", none of it is news.
    const baseline = prev === null;
    if (price && !price.stale && !baseline) {
      const call: BiasCall | null = (await deps.store.list('bias_calls', { instrument: symbol, status: 'intraday', until: iso(now + 1), limit: 1 }))[0] ?? null;
      const gen = w.generateUpdates({
        now, instrument: symbol, events: fresh, allEvents: all, lastPrice: price.price,
        call: call && Date.parse(call.expiresAt) > now ? call : null,
        positions: positions.filter((p) => mine(p.instrument)), tickets: open, prevState: prev, primary: primary.includes(symbol),
      });
      state = gen.state;
      if (gen.updates.length) {
        await deps.store.put('watcher_updates', gen.updates);
        for (const u of gen.updates) await deps.bus.publish('update', u);
        out.updates.push(...gen.updates);
      }
    }
    await deps.store.kvSet(KV.watcherState(symbol), state);

    for (const e of baseline ? [] : fresh) {
      if (now - Date.parse(e.ts) > Math.max(FRESH_SETUP_MS, 6 * TF_MS[e.tf])) continue;
      const i = notify.setupConfirmed(e, profile.instruments.watchlist);
      if (i) out.intents.push(i);
    }
  }
  return out;
}

/**
 * Base rates of the watcher's patterns per symbol, measured on the stored 15m and 1h candles of the last 90 days
 * (or the shorter span the store covers; each rate carries the span and its sample count).
 */
export async function computeBaseRates(deps: DeskDeps, now: number): Promise<number> {
  let n = 0;
  for (const symbol of await watchedSymbols(deps)) {
    const from = now - (w.BASE_RATE_WINDOW_DAYS + 30) * DAY;
    const [m15, h1] = await Promise.all([deps.store.getCandles(symbol, '15m', { from, to: now }), deps.store.getCandles(symbol, '1h', { from, to: now })]);
    if (m15.length + h1.length === 0) continue;
    const rates = w.computeBaseRates({ '15m': m15, '1h': h1 }, now);
    if (rates.length) { await deps.store.put('base_rates', rates); n += rates.length; }
  }
  await deps.store.kvSet(KV.baseRatesAt, iso(now));
  return n;
}

/** True when the daily base rates have not been computed in the last 20 hours. */
export async function baseRatesDue(deps: DeskDeps, now: number): Promise<boolean> {
  const at = await deps.store.kvGet<string>(KV.baseRatesAt);
  return !at || now - Date.parse(at) >= 20 * HOUR;
}
