Trading Desk — Build Spec for Claude Code
Nov 21, 2026 · @Amogh
1. Purpose and principles
Build a personal trading desk that forms a confident, evidence-weighted bias and names the single highest-probability trade, enforces sizing and exits per account, watches charts and news continuously, and pushes updates without being asked. It runs as a web app in Safari on iPhone and desktop. This spec is written for Claude Code to build end to end.
What it is. A catalyst-driven decision system for one discretionary trader (NQ futures, US tech perps, selected single stocks) across several prop-firm and perp accounts. It reads markets, rates, news and prediction markets, scores scenarios, and outputs a bias with a probability, a trade with a plan, and a size that survives the worst plausible path.
What it is not. It does not predict prices. It does not place orders. It does not override the trader's final decision. Every call it makes is a probability with the evidence beside it, never a certainty.
Non-negotiable rules the code must enforce, not just display
1.  No catalyst, no trade. Every trade ticket must reference a catalyst from the catalyst engine or the chart-watcher's confirmed setup list. Free-text reasons are rejected.
2.  Size is computed by the account-rules engine, never typed by hand. The user may size down, never up.
3.  Exits are written before entry: three targets, one invalidation, scale-out schedule. A ticket without them cannot be saved.
4.  No position may be carried through a Tier-1 catalyst (CPI, NFP, FOMC, the index's top-weight earnings) if the catalyst's expected move can reach the account's fail price. The system blocks the hold and says why.
5.  Decisions are scored on plan adherence first, P&L second. The journal keeps both; the dashboard leads with adherence.
6.  The system speaks in the user's register: short, direct, dry, occasionally funny. It names the behavioral pattern it sees, once, with the number that proves it. It never lectures twice.
Confidence policy. The bias engine must commit. Output is always one of: Strong long / Lean long / No edge / Lean short / Strong short, with a probability (0.50 to 0.85) and the three facts that drove it. "No edge" is a valid, frequent answer. A probability above 0.85 is never emitted; markets do not offer it.
2. The trader profile the system encodes
The system is built for one person, and its value comes from knowing where that person makes and loses money. Store this as profile.yaml; the bias engine, guardrails and notifications all read it.
Style and edge. Event-driven, catalyst plus timing. Best trades: a macro read made the night before (CPI, NFP, FOMC, a mega-cap print, a resolution headline), an entry at the moment the uncertainty resolves (a data release, a flush, a squeeze top), and a scale-out. Pure technical, wait-for-the-setup trading has not been where results came from. The trader reads macro and news well and times entries well.
Instruments. NQ (CME futures via prop firms; NQ perp on Vest), US mega-cap tech and chips (NVDA, AMZN, INTC, CRWV, SNDK), occasionally gold, oil, BTC/ETH. Primary timeframes: 1m and 15m for execution, 1H and daily for structure. Uses ICT-style structure language (liquidity, FVG, order blocks, MSS) and should see it reflected in the chart watcher.
Accounts. Multiple prop-firm accounts (MyFundedFutures Builder/Rapid/Pro, Apex, Lucid, Tradeify) and Vest Markets perp accounts (Instant and evaluation). Each has distinct drawdown, daily-loss, consistency, payout and leverage rules. The account-rules engine in section 7 encodes them.
Documented failure patterns (each becomes a guardrail in section 11):
Pattern
What it looks like
What it has cost
Sizing to the thesis, not the path
50x with the fail price 0.3 to 0.6% away into a live event
Correct direction, liquidated by a wick
Holding a winner past the plan
"Should I keep holding it fully" at the top; exits decided after the entry
Full round-trips of intraday gains
Regret after a correct exit
"If I had held I would have doubled"
Next trade sized bigger to make it back
Bottom-calling 24 hours after a flush
"I feel like the bottom is in" with no confirmation day
Early entries that get retested
Reading a squeeze candle as institutional buying
One spike through a moving average, rejected, read as strength
Holding into a failed bounce
Liquidity-run rationalization
"It will run the highs first" while long and stalling
Ignores the liquidity on the other side
Off-catalyst ideas, often late at night
Full-port gold on RSI, buy SNDK because it dropped
Trades with no edge
Cross-account hedging ideas
Opposite positions on two Vest accounts, or with a partner's account
Would void payouts and get accounts banned
What the trader wants from the system's voice. Direct, specific, numbers first, no hedging language, no lectures. It should name the pattern it sees in one sentence with the evidence, then give the action. Humor is welcome when it lands; moralizing is not.
Goals. Consistent payouts across accounts, then scaling notional as the plan-adherence score proves out. Secondary: a catalyst model good enough to express on Kalshi as well as in futures.
3. System architecture
A worker ingests the feeds every 60 seconds into a time-series store, five pure engines read that state and write their outputs to the journal, and three surfaces (the app, push notifications, the scheduled briefs) read from the engines and the journal. The trader's tickets and chat go back through the guardrails before they reach the engines.
Data flows top to bottom; the bias engine is the one box that must commit to a call, and the app is where the trader acts on it.
Stack. Next.js PWA (TypeScript, Tailwind, service worker for push and offline) in apps/web; FastAPI or Fastify in apps/api; engines as pure, tested packages in packages/engines; feed adapters in packages/feeds; Postgres with TimescaleDB for candles and the journal; Redis for live state and pub/sub; a scheduler (BullMQ or Celery beat) for the 60-second loop and the daily jobs; an LLM API for headline classification, the matrix prose, guardrail wording and the Ask surface. Deploy on Fly.io or Railway behind HTTPS so the PWA installs on iPhone; secrets in the platform vault; one environment variable per feed key.
Boundaries. Engines never call feeds directly; they read the store. The UI never computes a size or a call; it renders what the engines wrote. Every engine output carries its inputs and timestamp so a call can be replayed and the calibration page can score it.
4. Data feeds and sources
Every input below is a pluggable adapter behind one interface (Feed.subscribe(symbol | topic) -> stream), so a provider can be swapped without touching the engines. Start with the free or cheap tier of each; upgrade when latency matters.
Feed
What it provides
Candidate providers
Cadence
Priority
Futures and index prices
NQ, ES, YM, RTY; MNQ; SOX, VIX, DXY
Databento, Polygon, Tradier, TradingView webhooks; Vest and prop-firm platform APIs for the perp marks
Tick or 1-second
P0
Rates
US 2Y, 10Y, 30Y yields; 2s10s; Fed funds futures; CME FedWatch hike/cut odds
FRED (daily), CME FedWatch scrape, Polygon or Databento for futures
1-minute during US hours
P0
Single stocks
NVDA, AMZN, INTC, CRWV, NBIS, SNDK, TTWO, AMD, AVGO, MU, TSM; watchlist editable
Polygon, Alpaca, Tradier
1-second to 1-minute
P0
Economic calendar
Release times, consensus, prior, revisions; Tier-1 flag
Trading Economics API, Econoday, BLS/BEA schedules, Fed calendar
Daily refresh, live on release
P0
Headline feed
Macro prints, Fed speak, company news, geopolitics
FinancialJuice (RSS/API), Reuters/Bloomberg terminal if licensed, Newsquawk, X lists
Streaming
P0
Earnings
Dates, consensus, whisper, implied move, post-print history
Earnings Whispers, Alpha Vantage, OptionCharts for implied move
Daily
P0
Prediction markets
Kalshi and Polymarket odds on CPI buckets, Fed decisions, NFP ranges
Kalshi API, Polymarket API
1-minute
P1
Options positioning
Implied move, skew, put/call, gamma levels for NQ/SPX and watchlist names
CBOE data, SpotGamma or Menthor Q (paid), OptionCharts
Daily, intraday if licensed
P1
Flows and sentiment
ETF flows (QQQ, SOXX, GLD, IBIT), 13F dates, retail flow prints, VIX term structure
ETF.com, SEC EDGAR, Farside, CBOE
Daily
P1
Prop-firm rules
Drawdown type, daily limit, consistency, payout cycle, leverage caps, event restrictions, any rule change
Each firm's help center, scraped nightly and diffed
Daily, alert on change
P0
Commodities and crypto
CL, GC, BTC, ETH
Polygon, Coinbase, Binance
1-minute
P2
Analyst and strategist notes
Target changes, upgrades, house views (Morgan Stanley max overweight, Goldman Fed path)
Benzinga API, MarketBeat, Bloomberg if licensed
Daily
P2
Rules for the feed layer
• Every datum is stored with source, timestamp and freshness. A stale value is shown with its age; a value older than its cadence times three is flagged, never silently used.
• Headlines are deduplicated and classified (macro / Fed / earnings / company / geopolitical / firm-rules) by a small model before they reach the engines. Each classified headline gets a market-impact score 0 to 3 and a direction tag.
• 13F and similar filings are stamped with their as-of date, and the UI shows the lag ("positions as of Sept 30, 52 days stale").
• Firm-rule pages are diffed nightly. Any change creates a P0 notification and updates the account-rules engine before the next session.
• The trader's own feeds (FinancialJuice push, Discord stages) can be ingested via a forwarding rule or screenshot OCR as a P2 feature; the system must not depend on them.
5. Module 1: Catalyst engine and scenario matrices
The catalyst engine is the heart of the system because the trader's edge is catalyst plus timing. It turns every scheduled and unscheduled event into a pre-written scenario matrix with a trade per branch, so the thinking happens the night before and the execution at the moment is mechanical.
Catalyst object (catalysts table): id, name, tier (1 to 3), scheduled time, instruments affected, consensus, prior, whisper, implied move (from options), historical reactions (last 8 instances: first 5-minute move, first-hour move, close-to-close, whether the first move reversed), prediction-market odds, scenario matrix, status (upcoming / live / resolved), resolution values.
Tiering
• Tier 1: CPI, PPI, NFP, FOMC decision and minutes, Fed chair remarks, earnings of any name above 5% index weight, major IPO pricing (Anthropic), US-China summit outcomes. The system blocks carrying positions through these if the implied move can reach the fail price.
• Tier 2: ISM, JOLTS, retail sales, claims, PCE, regional Fed surveys, Fed speakers other than the chair, earnings of watchlist names, Treasury auctions when the 10Y is within 10 bp of a round level.
• Tier 3: everything else on the calendar; shown, not planned.
Scenario matrix generation (runs at 20:00 ET the day before, re-runs at 06:00 ET)
1.  Pull consensus, prior, whisper, and Kalshi/Polymarket bucket odds.
2.  Build three to five branches around consensus (for CPI core MoM: 0.1 or lower / 0.2 / 0.3 / 0.4 or higher). For earnings: miss / in-line / beat / beat-and-raise, crossed with the guide.
3.  For each branch, estimate the rate reaction (2Y and 10Y direction and size), the index reaction (first 15 minutes, first hour, close), and the second-order read (e.g., "hot core with hike odds at 90% is bearish; a 0.2 with odds at 90% is the squeeze branch"). Use the historical-reaction table for magnitudes, and the current regime (hiking vs. cutting, trend vs. correction) for sign.
4.  Attach a trade per branch: instrument, direction, entry trigger (e.g., "second move after 8:45 ET if the 10Y confirms"), three targets, invalidation, and the account that fits it (section 7).
5.  Attach the no-trade conditions: branches where the signal is ambiguous (hot headline, cool core) get "No edge, stand aside until 9:15."
6.  Attach the regime notes the trader has relied on: "first move trades the headline, second move trades yields"; "a beat is not a positive reaction; three of the last four Nvidia prints faded"; "weekend lock on Vest at 20:00 ET Friday."
Live handling. At release, the engine reads the print from the headline feed, matches the branch, pushes the branch's read and trade in one notification within 10 seconds, and starts the reaction clock: it reports the 5-minute and 15-minute moves against the historical table and says whether the reaction is normal, muted or extreme.
Unscheduled catalysts. A headline with impact score 3 (CEO resignation, export-control action, a central-bank surprise, a geopolitical strike) creates an ad-hoc catalyst, pulls the nearest analog from history (e.g., forced founder departures: median drawdown and recovery window), and produces a two-branch matrix (resolves / escalates) within 2 minutes.
Output. A catalyst card: the matrix as a table (branch, probability, rates read, index read, trade, size), the historical-reaction mini-table, the countdown, and a one-line "what I would do" that the bias engine owns.
6. Module 2: Bias engine, the confident highest-probability call
The bias engine answers one question continuously: what is the single highest-probability trade right now, with what confidence, and why. It commits. It is allowed to say "No edge." It is not allowed to hedge with language.
Inputs, each scored −2 to +2 for the instrument and horizon
Factor
Source
What moves it
Rates impulse
2Y and 10Y change over 1h / 1d; distance to round levels (5.00%)
Yields falling with stocks rising = +; yields rising through a round level = −
Fed pricing
FedWatch odds, Kalshi
Hike odds rising = −; a dovish surprise = +
Catalyst state
Catalyst engine
A resolved catalyst with a clear branch dominates everything for 2 hours
Regime
20-day trend, 50/200 EMA posture on daily and 15m, correction depth from high
Below falling 200 EMA = − bias to longs, bounces are sold
Breadth and leadership
SOX vs NQ, equal-weight vs cap-weight, defensives vs tech, advance/decline
Chips leading up = +; defensives bid while index flat = −
Positioning
Options skew and implied move, CFTC spec positioning, retail-flow prints, VIX level and term structure
Crowded one way = fade that way after a catalyst
Flow of news
Impact-scored headlines in the last 24h, net direction
Three negative impact-3 headlines in a day = −
Structure (ICT layer)
Liquidity above/below, FVGs, order blocks, MSS on 15m and 1H, failed-bounce detection
Bounce stalling under 50% retrace = −
Calendar and seasonality
Day of week, OpEx, month-end, holiday weeks, midterm-year pattern
Thanksgiving week = mild +; Friday before a long weekend = reduce
Cross-asset
DXY, oil, gold, BTC direction
Oil spiking with yields = −; bonds bid as safe haven = regime change flag
Scoring. Weighted sum per instrument and horizon (intraday, 1 to 3 days, 1 to 2 weeks), with the catalyst state as a multiplier when a catalyst is live or resolved within 2 hours. Weights start from the profile (catalyst 0.30, rates 0.20, regime 0.15, breadth 0.10, positioning 0.10, structure 0.10, news 0.05, other 0.05 of the remainder) and are re-fitted monthly against the journal's outcomes.
Output format, always
• Call: Strong long / Lean long / No edge / Lean short / Strong short.
• Probability: 0.50 to 0.85, calibrated against the journal (a 0.65 call must be right about 65% of the time over 50 calls; if not, the weights are wrong).
• The three facts that drove it, with numbers ("10Y −9 bp to 4.94% after PPI"; "SOX +4.6% while staples −1.1%"; "NVDA fell after 3 of its last 4 prints").
• The trade: instrument, direction, entry trigger, three targets, invalidation, time stop, which account.
• The kill condition: the one observation that flips the call.
• The next catalyst and when the call expires.
Rules
• The engine never changes a call on the same evidence. A new call needs a new fact: a print, a headline, a level broken, a time stop hit.
• If the first move after a catalyst contradicts the branch's expected rates read, the engine says "first move, not yet trusted" and waits for the second move. This rule is the trader's own and it has been right every data day on record.
• When the trader asks "up or down today?", the engine answers with the current call, its probability and its expiry, not a new analysis.
• When the trader asks about an instrument with no catalyst and no structure signal, the answer is "No edge" with the fact that would create one.
Calibration page. A chart of predicted probability vs. realized hit rate by bucket, updated weekly, with the count. This is the only honest way to earn the word "confident."
7. Module 3: Sizing and account-rules engine
The engine converts every trade idea into the largest size that survives the worst plausible path on the specific account, then shows the fail price in points and percent. The trader can size down, never up. Each firm's rules live in accounts/*.yaml, versioned, refreshed by the nightly rule-diff.
Per-account rule schema
Field
Examples
Drawdown type and amount
Vest: static 6% from start, equity-based incl. open P&L; MFFU Builder: EOD trailing, locks at +$100; Apex: trailing, Safety Net $52,100 for life; Lucid 25K: $1,000 trailing locks at $25,100
Daily loss limit
Vest: 3% of balance snapshot at 20:00 ET, hard breach; MFFU Builder: $1,000; Lucid 25K: none
Payout cadence and caps
Builder: $2,000 per cycle, 2 qualifying days, 50% consistency; Pro: 14 calendar days, $1,000 min, 60% pre-buffer; Apex: 5 qualifying days, 50% consistency, $1,500 to $3,000 ladder, closes after 6 payouts; Lucid Pro 50K: 3 days, 40%, $2,000 then $2,500; Vest: no cap, no schedule, claim anytime
Inactivity
MFFU: one trade every 7 calendar days or breach
Leverage and event caps
Vest: per-market caps (NQ 50x), temporary cuts around Tier-1 events, lifted one minute after release
Session rules
Vest: non-crypto locks Fri 20:00 ET to Sun 18:00 ET; no new NQ in that window; CME firms: flatten before 16:00 ET
Prohibited
Cross-account hedging (all firms), news trading on MFFU Pro, scalps under 5 to 10 seconds on Tradeify and Lucid, stop-entry orders unavailable on Vest
Buffer and locked capital
MFFU: $2,100 buffer on 50K; everything above withdrawable
Sizing algorithm, run on every ticket
1.  Determine the worst plausible adverse move over the holding window: the larger of (a) the instrument's 95th-percentile move for that window from the last 60 sessions, (b) the implied move of any Tier-1 catalyst inside the window, (c) 2.5 times the current 1-minute ATR for intraday scalps.
2.  Compute available room on the account: distance to fail price or drawdown floor, and to the daily limit, whichever is nearer, less a 20% cushion for feed divergence and slippage (Vest marks have diverged 10 to 40 points from CME).
3.  Size = room / worst move. Show the result as notional, leverage, and the fail price in points and percent.
4.  If the holding window crosses a Tier-1 catalyst and the implied move exceeds the room, block the ticket with the message "This cannot survive [catalyst] at any size above X; the catalyst trade is [the branch trade] at X."
5.  If the window crosses a Vest weekend lock, size against the weekend gap distribution (3% minimum assumed) and say so.
6.  Show the consistency and payout implications: "A +$1,200 day today puts your best day at 58% of this cycle; request after one more green day."
Position monitor. For every open position: live distance to fail price in points and percent, time to the next snapshot or lock, the catalyst inside the window, and a single-line status: Safe / Thin / Critical. Critical means a one-ATR move ends the account; the system pushes it immediately and repeats every 5 minutes until acted on.
Hedging detector. If two accounts under the trader's control hold opposite or strongly correlated-opposite exposure (NQ short on one, NVDA long on another), the system flags it as a rule violation before the second order is placed, with the firm's clause quoted.
Firm-risk notes. Vest is a Panama-law counterparty with liability capped at fees paid and discretion over "abusive" trading; the engine prompts a claim after any single-session gain above 25% of the account, and keeps the default advice as "claim often, withdraw same day."
8. Module 4: Trade plan enforcement
Every trade is a ticket with the exits written before the entry, and the system scores the trader on whether the ticket was followed. This module exists because the two most expensive patterns on record are holding past the plan and regretting a correct exit; both come from deciding at the top.
Ticket fields (all required to save)
• Catalyst reference (from Module 1) or confirmed structure setup (from Module 5).
• Instrument, direction, account.
• Entry trigger: a price, a time, or a condition ("second move after 14:45 if 10Y confirms"), never "now" without one.
• Size from Module 3 (editable down only).
• Target 1, Target 2, Target 3 with the scale-out fractions (default one-third each; the runner carries a trailing stop at the prior swing).
• Invalidation price and the reason it invalidates the thesis ("reclaims the after-hours high with chips leading").
• Time stop: the latest time the thesis is still valid ("flat by 15:30 ET; print at 16:00").
• Hold-through-catalyst flag: set automatically; if true and the catalyst's implied move can reach the fail price, the ticket is blocked.
Execution tracking. The system does not place orders. It watches fills from the account feed (or manual confirmation) and tracks the position against the ticket: which targets hit, whether the stop was honored, whether size was added. Any divergence from the ticket is logged as an override with the trader's one-line reason, captured in the moment.
Override policy. Overrides are allowed, because the trader is discretionary, but each one costs a prompt: the system shows the plan, the live P&L, and the running cost of overrides this month ("Overrides are −$6,400 month to date across 7 instances; the last one that paid was Nov 6"). Then it lets the trader decide.
Plan-adherence score. Per trade: 100 if entry trigger, size, scale-outs, invalidation and time stop were all followed; deductions per deviation (size up −40, held through invalidation −30, held through time stop −20, skipped a scale-out −10, added to a loser −40). Rolling 20-trade score is the dashboard's lead number, above P&L.
The regret killer. After every closed trade the journal records: exit price, the maximum favorable excursion after exit, the maximum adverse excursion after exit, and the plan's target. The weekly review shows "plan-following exits captured X% of the available move; overrides captured Y%." Over a month, this number is what ends the argument about whether to hold or sell.
Re-entry rule. After a stop-out, no re-entry in the same instrument and direction within 15 minutes unless a new catalyst or a new structure confirmation exists. The ticket form enforces this with a timer.
Daily circuit breakers (per account, user-set, system-enforced via warnings)
• Three plan-breaking trades in a day: the desk goes to read-only for the rest of the session and says why.
• A single-session gain above 30% of the account on Vest: prompt to claim before the next catalyst.
• Any ticket created between 23:00 and 06:00 local time without a scheduled catalyst inside 12 hours: the system asks for the catalyst twice, then saves it as a watch, not a trade.
9. Module 5: Live chart watcher and autonomous updates
The watcher runs server-side on streaming prices and produces structure events the way the trader reads charts, so the system can report "the bounce has stalled under the 50% retrace with ES making lower highs" without being asked.
Timeframes watched: 1m, 5m, 15m, 1H, daily for NQ, ES, SOX, VIX, the 2Y and 10Y, and every watchlist stock. Candles are built from the price feed; no third-party charting dependency in the core path.
Detectors (each emits an event with instrument, timeframe, level, timestamp, and a confidence)
Detector
Definition
Why it matters to this trader
Swing highs/lows and liquidity pools
Fractal highs/lows; equal highs/lows within 0.1% flagged as resting liquidity
The liquidity-run framing the trader uses, with both sides shown
Sweep and reclaim
Price trades through a swing low/high and closes back inside within N candles
The entry pattern behind the best trades on record
Market structure shift (MSS) and break of structure (BOS)
Close beyond the last lower-high / higher-low
Confirms or denies a reversal before size goes on
Fair value gaps and order blocks
Three-candle imbalance; last opposing candle before an impulse
Targets and invalidation levels in the trader's language
EMA posture
20/50/200 on 15m and daily; first-touch rejection vs. reclaim-and-hold
"Rejected off the 15m 200 EMA" is a known false signal on first touch
Retrace quality
Bounce as a fraction of the prior leg; stall under 50% = bear flag
The exact tell that would have cut the Nov 16 long earlier
Divergence
NQ vs ES, NQ vs SOX, index vs 10Y
Rotation vs. broad weakness
Volume context
Impulse volume vs. bounce volume; squeeze candles on falling volume
Distinguishes covering from accumulation
Range and compression
Pennants, inside bars, opening-range state
Last-hour compression under the midpoint before a print
Autonomous update loop (every 60 seconds during US hours, every 5 minutes overnight)
1.  Pull new candles and headlines.
2.  Run detectors; diff against the last state.
3.  If a state change touches an open position, a live ticket, or the current bias call's kill condition, generate an update.
4.  Pass the update through the bias engine for a one-line read and through the guardrails for any pattern flag.
5.  Deduplicate: the same observation is never pushed twice; a worsening of it is.
6.  Push to the app's live feed; push a notification only if it meets the thresholds in Module 6.
Update format (plain text, under 280 characters, numbers first): "NQ 27,062, reclaimed the 1m EMA at 27,024; bounce now 58% of the 17:00 drop. ES still lower highs. Call unchanged: Lean short, 0.58, expires 15:30 ET. Half off at 27,130 per ticket."
What the watcher never does. It never upgrades a single candle into a conclusion. A spike through a moving average is reported as "spike, rejected, volume below the impulse," not "institutional buying." Patterns are stated with their base rates from the journal ("first-touch rejection of a declining 200 EMA: 71% in the last 90 days").
10. Module 6: Notifications
The system pushes to the phone what the trader would otherwise ping for, and nothing else. Over-notifying trains the user to ignore it; the budget below is enforced in code.
Channels. Web push via the PWA (iOS 16.4+ supports it when the app is added to the Home Screen), with Telegram or iMessage-via-shortcut as a fallback channel for P0 only. Each notification deep-links to the relevant card in the app.
Priority classes and budget
Class
Triggers
Budget
Sound
P0 Act now
Position status Critical; a Tier-1 print resolved with the branch trade; a firm rule change; an impact-3 headline on an instrument with an open position; a ticket's invalidation or time stop hit
Unlimited, but each repeats at most every 5 minutes
Yes, overrides silent
P1 Trade available
Bias call changes to Strong or from No edge; a catalyst-engine entry trigger fires; a chart-watcher setup confirms (sweep-and-reclaim with MSS) on a watchlist name
Max 8 per US session
Yes during US hours
P2 Worth knowing
Catalyst T-60 minutes reminder with the matrix; Vest weekend lock T-30; payout eligibility reached; inactivity-rule deadline T-24h; a scenario branch's probability shifts by 15 points on prediction-market odds
Max 6 per day
No
P3 Brief
Morning brief at 06:30 local; post-close recap at 16:30 ET; weekly review Sunday 18:00
Scheduled only
No
Quiet hours. 23:30 to 06:00 local, P0 only. The late-night-idea guardrail still runs if the trader opens the app.
Message template. First line: the fact with the number. Second line: the call or the action. Third line, optional: the pattern flag, once. Example: "Core CPI 0.3% vs 0.2%. Branch C: Lean short NQ 0.62, entry on second move after 14:45, T1 27,000. 10Y +9 bp to 4.95%."
The trade-entry notification must contain everything needed to act from the lock screen: instrument, direction, account, size from Module 3, entry trigger, T1, invalidation, time stop. Tapping it opens a pre-filled ticket.
Suppression rules. No notification repeats the previous one's content. No P1 inside 10 minutes of a P0 on the same instrument. If three P1s in a row are ignored (no tap within 15 minutes), the system drops to P0-only for 2 hours and notes it in the journal.
Voice. Same as the app: numbers first, short, dry. A notification never says "consider" or "you may want to." It says what the call is and what the trader's own plan says to do.
11. Module 7: Behavioral guardrails
Guardrails are detectors that run on the trader's own inputs (tickets, chat messages, timing, size changes) rather than on the market. Each fires at most once per episode, states the pattern with the evidence, and gives the action. They are the part that makes the system personal rather than a terminal.
Pattern library (seed with these; the journal adds to it)
Trigger
Detection
Response
Bottom-called within 24h of a flush
Phrases like "bottom is in" or a long ticket within 24h of a 2%+ down day with no confirmation-day event
"Flush was 19h ago. Confirmation day hasn't printed. Quarter size until it does; the Nov 6 and Nov 16 lows both needed one."
Hold-the-winner
A question containing "hold" or "fully" on an open position above T1
Shows the ticket, current P&L vs plan, and the override ledger: "Overrides −$6,400 MTD. Plan says one-third off at 27,130. That's 40 points away."
Size creep after a win
New ticket notional more than 1.5x the 20-trade median within 24h of a gain above 20% of the account
"Size is 2.1x your median after a +45% day. The engine's survivable size is X. Confirm X or lower."
Thin fail price
Fail price within 1.5x the 1-minute ATR
Status Critical, pushed every 5 minutes
Squeeze candle read as strength
Trader describes a single spike as institutional; watcher shows rejection and sub-impulse volume
"That candle: +110 pts, rejected within 4 minutes, volume 60% of the 17:00 impulse. Covering, not accumulation."
Liquidity-run rationalization
"Will run the highs" while long and the retrace is under 50%
"Liquidity sits both sides: buy stops 1.2% up, sell stops 1.7% down, fail price 1.0% down. Order of arrival decides, not the thesis."
Hedge-the-decision
Asks about shorts while long the same instrument
"Long and short the same index is flat plus fees. Cut size or close; don't cancel the trade."
Cross-account offset
A ticket that would create opposite exposure on another account
Blocked with the firm clause: "Vest: coordinating accounts incl. opposite positions is prohibited."
Late-night off-catalyst idea
Ticket or question 23:00 to 06:00 local with no catalyst inside 12h
Asks for the catalyst; saves as a watch after two misses
Regret loop after a correct exit
Message compares exit to a later higher price
Shows plan-capture vs override-capture for the month; one line: "Plan exits captured 61% of available moves; overrides 23%."
Research-as-permission
Trader cites a stale 13F, a crowd consensus, or a restated buyback as fresh
Stamps the age or restatement: "13F is as of Sept 30, 52 days stale."
Catalyst hold
Any open position whose window crosses a Tier-1 event with implied move above room
Blocked unless the ticket is the catalyst trade at survivable size
Tone rules in code
• One sentence of pattern, one of evidence, one of action. No third paragraph.
• Never the same flag twice in an episode; a repeat is replaced by the override ledger number.
• Acknowledge the correct reads when they happen ("You called the Nov 6 low and the Nov 17 top tick"), because the credibility of the warnings depends on the system being fair.
• Humor allowed, sarcasm not. The user asked for a glove, not a parent.
Learning loop. Each guardrail firing is logged with what the trader did next and the outcome. Monthly, the system reports which guardrails saved money, which were ignored and cost money, and which fired on nothing. Thresholds are tuned from that; a guardrail that fires on nothing three months running is retired.
12. Module 8: Morning brief, journal and self-improving memory
The brief does the overnight research so the trader reads one page; the journal records what happened and why; the memory layer turns both into a sharper model of the trader and the market each week.
Morning brief (06:30 local, regenerated at 08:00 ET if anything changed)
1.  The call: today's bias per instrument, probability, expiry, the three facts.
2.  Overnight in five lines: Asia and Europe closes, the 10Y and 2Y with the change, DXY, oil, BTC, VIX, NQ futures vs. fair value.
3.  Catalysts today: each with its matrix card collapsed to the consensus, the whisper, the implied move and the branch trade.
4.  Open positions and tickets: status, distance to fail, what the plan says today.
5.  Account state: claimable balances, consistency math, payout and inactivity deadlines, any rule change overnight.
6.  The one thing: the single trade the engine would take today, or "No edge until [catalyst]."
7.  Reads worth two minutes: three headlines with the market-impact score and a one-line why, never a wall.
Post-close recap (16:30 ET). What the call was, what happened, whether the call was right, the plan-adherence score for the day, the override ledger, tomorrow's catalysts. Under 200 words.
Weekly review (Sunday 18:00). Calibration chart (predicted vs realized by bucket), plan-capture vs override-capture, guardrail scorecard, the three best reads of the week and what they had in common, the three worst and what they had in common, next week's catalyst calendar with Tier-1 windows blocked out.
Journal schema (trades, calls, events, notes)
• trades: ticket snapshot at entry, fills, scale-outs, exit, MFE and MAE after exit, adherence score, overrides with reasons, account, catalyst id, chart-watcher events in the window, screenshots.
• calls: every bias output with its inputs, probability, expiry, and the realized outcome at expiry.
• events: every guardrail firing, what the trader did, the outcome.
• notes: the trader's own observations in their words, timestamped, searchable ("my best trades are catalyst plus timing" lives here as the seed).
Memory layer. A vector-indexed store over the journal and the trader's chat with the system, so the assistant can answer "what happened the last three times I held through earnings" with the actual trades and numbers. Weekly, the system writes a short memo to profile.yaml: edges confirmed, patterns observed, weights adjusted, with the evidence. The trader edits it; nothing is written there that the trader hasn't seen.
Research assistant. A chat surface in the app backed by the same memory and feeds. It answers in the system's voice, cites the feed and the as-of time for every number, flags stale data, and refuses to give a direction without a probability and a kill condition. It can be asked to "check live" and will pull the latest feeds before answering, so the trader never has to say it twice.
13. UI spec
A phone-first PWA that opens in Safari, installs to the Home Screen, and works one-handed. Dark theme, numbers first, no decorative charts. Every screen answers one question in the top third without scrolling.
Navigation (bottom tabs): Now · Catalysts · Positions · Journal · Ask.
Now (home). The bias card: instrument, call, probability, expiry, three facts, kill condition, and a single action button (Open ticket / No edge). Below it: the live update feed from Module 5 (newest first, each under 280 characters), the rates strip (2Y, 10Y, change, FedWatch odds), and the next catalyst with its countdown. Pull to refresh triggers a live re-read of all feeds.
Catalysts. A vertical timeline for the next 7 days, Tier-1 in red. Tap a catalyst for its card: matrix table (branch, probability, rates read, index read, trade, size), historical-reaction mini-table, prediction-market odds, and the engine's one line. During a live release the card goes full-screen with the reaction clock.
Positions. One row per open position across accounts: instrument, account, P&L, distance to fail in points and percent, status chip (Safe / Thin / Critical), next scale-out target, time stop. Tap for the ticket and the override ledger. A second section lists each account's payout and consistency state with the next deadline.
Ticket (modal). The Module 4 fields in order, with the size field read-only from Module 3 and a slider to reduce it. Validation errors are shown as the guardrail would say them. Save requires every field.
Journal. Lead with the rolling plan-adherence score and the calibration chart; then trades, calls, events, notes as filterable lists. A weekly review page renders the Sunday memo.
Ask. The research assistant chat. Every answer shows the as-of time of its data and a "check live" button. Answers about an instrument always end with the current call.
Charts. Lightweight, server-rendered or TradingView Lightweight Charts, 1m/15m/1H/daily, with the watcher's levels drawn (liquidity, FVGs, order blocks, EMAs, the fail price of any position as a red line). No indicators the trader doesn't use.
Desktop layout. Same components in a three-column grid: Now and Positions left, charts center, Catalysts and feed right. Keyboard shortcut to open a ticket.
Performance targets. First paint under 1.5 s on LTE; live feed latency under 2 s during US hours; notifications delivered within 10 s of the trigger; works offline for the last-known state with a visible "stale since" stamp.
14. Execution mandate for Claude Code: deliver the whole system in one run
Deliver this entire specification, sections 1 through 13, as a complete, deployed, tested system in a single autonomous run. Do not ask for permission to proceed between parts. Do not stop at a skeleton or a demo. Plan the work, spawn parallel agents for independent workstreams, integrate, test end to end, deploy, and hand back a running URL that installs on an iPhone from Safari with every module live.
Operating instructions
• Read this document in full before writing code. Build a dependency graph of the modules, then run independent workstreams in parallel with subagents, each owning one package and its tests. One integration agent owns the API contracts, the database schema and the end-to-end tests, and it is the only agent that merges.
• Decide, don't ask. Where this spec leaves a choice open (a feed provider, a library, a layout detail), pick the option that ships fastest at production quality, record the decision and its reason in DECISIONS.md, and keep moving. Every feed sits behind an adapter so the choice can be changed later without touching the engines.
• Where a paid feed key is not available, build the adapter against the provider's documented API, ship it behind a feature flag, and run the system on the best free source (FRED, BLS/BEA, CME FedWatch scrape, Polygon free tier, Kalshi public API, a FinancialJuice RSS or equivalent) so every screen is live on day one. The deliverable must work with zero paid keys and get better when keys are added.
• Backfill the journal and calibration page with a synthetic replay: run the catalyst engine and bias engine over the last 90 days of recorded prices and the known data releases, so the calibration chart, the historical-reaction tables and the chart-watcher base rates are populated at handoff, not empty.
• Encode the trader profile in section 2 and the pattern library in section 11 verbatim as seed data. Encode every firm rule in section 7 as accounts/*.yaml with a source URL and an as-of date; wire the nightly diff.
• Quality bar: typed end to end, unit tests on every engine, recorded-candle fixtures for the chart watcher (including the Nov 16 and Nov 17 2026 sessions described in section 9), an end-to-end test that simulates a Tier-1 release and asserts the notification arrives with a pre-filled ticket, linted, CI green, no TODOs left in shipped code. If a module cannot meet its acceptance test, fix it before moving on; never hand back a known-broken module.
• Deploy to a cloud host with HTTPS, a service worker, web push, scheduled jobs, and a kill switch. Provide README.md with the install-to-Home-Screen steps, the environment variables, and how to add each paid feed.
Parallel workstreams (run concurrently; the integration agent merges in this order)
Workstream
Owns
Depends on
Acceptance test
Platform
Monorepo, Postgres+Timescale, Redis, scheduler, deploy, PWA shell, push
None
App opens in Safari, installs to Home Screen, receives a test push
Feeds
Every adapter in section 4, the headline classifier, the firm-rule scraper and diff
Platform schema
Now screen shows live NQ, the 10Y with 1h change, today's catalysts with consensus; a rule-page change raises a P0
Account rules and sizing
accounts/*.yaml, the sizing algorithm, position monitor, hedging detector
Platform schema
A 50x Vest position with a 0.6% fail price returns Critical and a survivable size; a Tier-1 catalyst inside the window with implied move above room blocks the ticket
Tickets and journal
Ticket form and validation, override capture, adherence scoring, MFE/MAE, journal tables, memory index
Platform schema
A ticket cannot save without targets and invalidation; a closed trade shows adherence and MFE/MAE; Ask answers a question about a past trade with its numbers
Catalyst engine
Catalyst objects, scenario matrices, historical-reaction tables, live matching, ad-hoc catalysts
Feeds
For a past CPI the T-1 matrix contains the branch that occurred, with a defined entry, targets and invalidation; the live match pushes within 10 s
Chart watcher
All detectors in section 9, the 60-second loop, update generation
Feeds
On the Nov 16 fixture it flags "bounce stalled under 50%" before the last hour; on Nov 17 it flags the 18:00 spike as rejected on sub-impulse volume
Bias engine
Factor scoring, weights, output format, expiry, kill condition, calibration page, weekly re-fit
Catalyst, Watcher, Feeds
Every call stored with inputs; calibration chart renders from the 90-day replay; "No edge" returned when no catalyst and no structure event
Guardrails
Pattern library as rules over tickets and chat, override ledger, circuit breakers, tone templates
Tickets, Bias
Bottom-call, size-creep, hold-the-winner, cross-account and late-night rules each fire on a scripted scenario and not on a control
Notifications
Priority classes, budgets, quiet hours, suppression, deep links
Platform, Bias, Catalyst, Watcher
Simulated Tier-1 release pushes the branch trade in under 10 s; the P1 budget caps at 8; quiet hours hold P1 to P3
Briefs and Ask
Morning brief, post-close recap, weekly review, the research chat with memory and "check live"
Journal, Bias
Brief arrives at 06:30 local with all seven sections; Ask stamps the as-of time on every number
Integration
API contracts, schema migrations, end-to-end tests, CI, DECISIONS.md, README.md, handoff
All
Full suite green; a scripted trading day runs end to end (brief, catalyst, call, ticket, guardrail, notification, recap) with no manual step
Definition of done. A live URL; the PWA installed and pushing; every section-1 rule enforced in code; every acceptance test above passing in CI; the calibration page, historical-reaction tables and watcher base rates populated from the 90-day replay; the morning brief scheduled and verified once; DECISIONS.md and README.md complete; a 10-minute handoff note listing what runs on free data today and exactly which keys unlock which upgrades. Then, and only then, report back.


also you and this system is free to access my browsers to download trading view data contributing to knowing everything about everything, ability to test ideas in real time and parse the success probabilities of certain trade types based on past chart data coupled with historical economic, financial, and political events. and also free to explore all other ways of accessing real time candle data to advise me and notify me about trades with precision.