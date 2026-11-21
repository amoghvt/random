# Integration notes

State at the start of integration (2026-11-21): ten workstreams delivered; 423 tests pass; `tsc` clean. The pieces are built against `packages/contracts` but have never run together. This file is what each workstream reported that the integrator must act on.

## What exists
- `packages/contracts`: types, `Store` interface, `ApiRoutes`.
- `packages/db`: `createStore(env)`, `PgStore`, `MemoryStore`, `migrateStore`.
- `packages/feeds`: `buildFeeds(env)`, `ingestOnce(store, feeds, now, opts)`, `backfillCandles`, `checkFirmRules`, `classifyHeadline(s)`, `LlmClient` / `llmFromEnv` / `nullLlm`, `stamped`, `lagText`, `changeBp`, `parseTradingViewCsv`, `titleToEventCode`, `fedWatch`, `loadRecordedCandles`, `loadRecordedCalendar`, `testing.ts` FakeStore.
- `packages/engines/src/{catalyst,bias,sizing,tickets,watcher,guardrails,notify,briefs}`: each has an `index.ts`. There is no `packages/engines/src/index.ts` yet. `bias` exports generically named `px` and `sg`, so a top-level `export *` collides: export namespaces (`export * as bias from './bias'`).
- `apps/api`: Fastify shell (`buildApp`, `createDeps`, `Bus`, `Pusher`, `Scheduler`, `startWorker` with no jobs yet), routes for health, auth, push, notifications, profile, admin/kill, hooks/tradingview, import, stream. New routes: add `routes/x.ts` exporting `register(app, deps)` and list it in `routes/index.ts`.
- `apps/web`: Next.js static export (in progress by the web workstream; do not edit).
- `accounts/*.yaml`: nine accounts. `loadAccounts()` in `sizing/load.ts`.
- `data/recorded`: raw candles and US calendar.

## Contract changes requested (apply all that are additive and optional)
- `AccountState.startingBalance?: number`, and on `AccountStateBody`. Sizing already reads it; Vest accounts are blocked until the trader enters it.
- `AccountRow`: add `claimPrompt: string | null`, `usableUsd: number`, `blockReason: string | null`.
- `Catalyst`: optional `secondary`, `keyedOn`, `earnings`, `tierReason` (see `catalyst/types.ts` `CatalystEx`).
- `HistoricalReaction`: optional `m15Pct`, `resolution`, `time`.
- `ScenarioBranch`: optional `conviction`; add `'fed_pricing'` to `probabilitySource`.
- `MemoryHit { id, kind, ts, text, score?, source? }` (defined locally in `briefs/types.ts`).
- `OverrideLedger.pendingInstances?: number`.
- `feeds.health` row: optional `lastPoll`.
- Document units: `Quote.changePct` is percent (e.g. -5.54); `fed.*_prob.next` data are 0-1.

## Behaviours the worker must respect
- Tickets: `closeTicket` leaves post-exit MFE/MAE null; call `settleResult(ticket, candles, now)` each loop until `complete`. `detectDeviations` and `ticketAlerts` run each loop for open tickets.
- Notifications: call `decide()` for every intent; deliver with the `Pusher` only when `decision === 'sent'`; always store the record. Offering a Critical intent every loop writes a suppressed record each time: offer it only when due (5-minute spacing) or drop suppressed duplicates before storing. Call `sweepIgnored` each loop. `tier1Resolved` takes `{lines, plan}` from `catalyst.branchNotification`; an unsized plan is pushed without a prefill, so size the plan with the sizing engine first (pick the fitting active account). Deep links: `/ticket?prefill=<notification id>`, `/positions?id=<ticket id>`, `/journal?brief=<id>`, `/catalysts?id=<id>`.
- Briefs: `briefDue('morning_regen', ...)` takes the last regeneration check time, not the last replacement.
- Guardrails: `GuardrailContext` needs `accountRules`, `reentry` (from the tickets engine), `correctReads`, `thresholds`, `ledger`, `confirmationDays`.
- Bias: `decideCall` returns the previous call object when no fact is new; only store and publish when the id changed. `scoreOutcome` returns null until candles reach expiry. Datum-only factors go stale on weekends by the plain 3x-cadence rule; that is expected and is displayed as stale.
- Feeds: run Node with `NODE_USE_ENV_PROXY=1` in this sandbox for live fetches. `changeBp` never mixes sources. Free NQ quotes are 10 minutes delayed (TradingView) and stamped so.
- Catalyst: `generateMatrix` throws without a template or consensus/prior: check `cannotPlanReason` first. An FOMC hold needs a tone input to pick dovish vs hawkish; without it the catalyst stays `live` and the push says so.
- Sizing: four accounts are blocked until the trader confirms numbers (vest-instant, vest-eval: account size; apex-50k, tradeify-50k: drawdown). `defaultAccountState` gives `active: false`.
- Watcher: `generateUpdates` emits at most one update per tick; sweep-and-reclaim follow-through measured at 45-46% on recorded NQ, so setups carry their base rate in the text.
- Platform: `GET /api/notifications` returns sent ones only (`?all=1` for all). `KV.lastLoop` is an ISO string. With no `DESK_TOKEN` outside production the API is open on 127.0.0.1.

## Known gaps to close in integration
- Engine-backed routes in `ApiRoutes` not yet implemented: now, refresh, catalysts, positions, accounts, tickets (all), journal, journal/notes, briefs/latest, ask, charts.
- The worker loop (60 s in US hours, 5 min overnight) and the daily jobs (matrix 20:00 ET and 06:00 ET, morning brief, 08:00 ET regen, recap 16:30 ET, weekly Sunday 18:00 local, nightly firm-rule diff, weekly calibration, monthly re-fit).
- The 90-day replay that populates calls, calibration, historical-reaction tables and base rates.
- End-to-end tests, README, handoff note.
