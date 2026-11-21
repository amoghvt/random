# Workstream rules (shared by every build agent)

Repo: `/home/user/random/desk` (pnpm monorepo, TypeScript strict, ESM, vitest, no build step: packages export `src/*.ts`, run with `tsx`).

Read first, in this order:
1. `docs/SPEC.md` — the trader's full build spec. Read sections 1 and 2 plus the sections named in your brief, in full.
2. `packages/contracts/src/{schemas,store,api,time,instruments,util}.ts` — the cross-module types. These are the contract.
3. `profile.yaml` — the trader profile.

## Ownership
- You own only the directories named in your brief. Do not edit anything else, including `packages/contracts`.
- If you need a contract change, do not block: define what you need locally in your module, and list the exact requested change in your final report. The integrator applies it.
- Other agents are building in parallel in the same working tree. Typecheck errors in files you do not own are not yours; ignore them. Never "fix" another workstream's files.
- Do not `git commit`, `git add`, `git stash`, or switch branches. The integrator is the only one who commits.
- Do not run `pnpm install` or add dependencies unless your brief says you may. Available everywhere: `zod`, `yaml`, node built-ins, `@desk/contracts`.

## Engine purity (packages/engines)
- Engines are pure functions: state in, output out. No network, no filesystem (YAML/fixture loaders are separate, clearly named files), no `Date.now()` and no randomness inside engine logic. Take `now: number` (epoch ms) as an argument. Use `hashId(...)` from contracts for deterministic ids.
- Every engine output carries its inputs and timestamp so a call can be replayed.
- Export everything from your directory's `index.ts`.

## Honesty about data (non-negotiable)
- Never fabricate market data, release values, base rates, firm rules or URLs. Real recorded data is in `data/recorded/` (raw Yahoo chart JSON and the TradingView US economic calendar with actual/forecast/previous back to 2024-07); load it with `loadRecordedCandles` / `loadRecordedCalendar` from `@desk/feeds/recorded.ts`.
- Recorded 1m candles cover 2026-11-13 to 2026-11-21 (so the Nov 16 and Nov 17 2026 sessions are real). 5m/15m cover 60 days, 1h covers 730 days, 1d covers 5 years.
- Hand-built candle sequences are fine for unit-testing a detector's logic, and must be obviously synthetic in the test (named `synthetic`). Anything presented to the trader as history or a base rate must come from recorded data.
- If an acceptance test cannot be met on the real data, say so in your report with the numbers. Do not bend the detector, the data or the assertion to force a pass.
- Any number shown to the trader carries its source and as-of time. Stale (> 3x cadence) is flagged, never silently used.

## Voice (anything the trader reads)
Short, direct, dry, numbers first. No "consider", "you may want to", "perhaps". One sentence of pattern, one of evidence, one of action. Never lecture, never moralize. Probabilities are 0.50 to 0.85, never higher. "No edge" is a valid, frequent answer.

## Quality bar
- Typed end to end, no `any`, no `@ts-ignore`, no TODO/FIXME comments, no placeholder or stub logic in shipped paths.
- Unit tests colocated as `*.test.ts`. Run yours: `pnpm vitest run <your-dir>`. Typecheck: `npx tsc --noEmit -p tsconfig.json` (filter output to your files). Lint: `npx eslint <your-dir>`.
- Your acceptance test from the brief must exist as a named test and pass before you finish.
- Keep code compact and readable; comments only where the why is not obvious.

## Final report (keep it under 400 words)
1. Files created. 2. Public API: exported function signatures the integrator will call. 3. Acceptance test: name and result, with real numbers. 4. Requested contract changes. 5. Anything unverified, approximated or not done, stated plainly.
