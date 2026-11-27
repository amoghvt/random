# Jarvis: a discretionary NQ trading agent

A trading agent that reads the Nasdaq-100 futures picture, your own notes and its
own journal, forms a discretionary view with Claude, checks that view against hard
risk rules it cannot change, and then (depending on mode) logs it, proposes it for
your yes, or places it.

It runs on your machine, which is where your files and your broker are. One
Python 3.10+ process, one dependency (`anthropic`).

## What it is and is not

- **It is** a complete loop: data in, picture built, brain decides, risk gates,
  broker acts, everything journaled, end-of-day review feeds tomorrow.
- **It is not** a profit machine. NQ is the most competed contract there is. The
  value here is process: it never trades outside your rules, never without a stop,
  never after the daily loss limit, and it writes down why it did everything.
- **Data is delayed.** Out of the box it reads Yahoo's free, delayed, unofficial
  NQ=F bars. That is fine for paper and for learning the system. It is not a tape.
  For real-time you wire a feed into `jarvis_core/data.py` (Tradovate's WebSocket,
  Databento, your platform's export).
- **Paper first.** The default broker is a simulator. The Tradovate adapter targets
  the demo environment and was written against the documented API but not run
  against an account in this repo. Verify every call in demo before going live.

## Quick start

```bash
cd jarvis
pip install -r requirements.txt
cp config.example.json config.json           # edit limits, windows, event dates
cp knowledge/playbook.example.md knowledge/playbook.md   # make it yours
export ANTHROPIC_API_KEY=sk-ant-...           # or `ant auth login`
python3 jarvis.py ingest                      # index knowledge/
python3 jarvis.py picture                     # the levels, no model call
python3 jarvis.py brief                       # one read of the market, nothing placed
python3 jarvis.py run                         # the loop, in propose mode
```

In `propose` mode, an entry the brain wants and risk allows becomes a proposal:

```
PROPOSAL 3f9a2c1e: long 1 @ market stop 24810.00 target 24872.00 conf 0.71
   thesis: ...
   approve with: python3 jarvis.py approve 3f9a2c1e
```

Approve it from another terminal. Proposals expire after 15 minutes, and are
re-checked (price drift, risk) at approval time.

## The three modes

| mode | entries | managing an open position |
| --- | --- | --- |
| `observe` | logged only | logged only |
| `propose` | need `approve <id>` | brain can close or move the stop |
| `auto` | placed when risk passes | brain manages |

`auto` on a paper account is one line in config. `auto` on a live account also
needs `"i_accept_live_autonomous_risk": true`, on purpose. The suggested path is
weeks in `observe` and `propose` on paper, reading the reviews, tuning the playbook,
then `auto` on paper, then live with one contract if the journal earns it.

## Trading a Vest Markets account through the browser

Vest has no API for funded accounts, so `broker.kind: "vest_browser"` drives the order form in a Chrome window
that you logged in to. Vest's Prop Terms (section 9) class bots and scripts as third-party tools used at your own
risk: Vest does not support them and is not liable for a failed or unintended trade.

```bash
pip install playwright
python3 jarvis.py vest-check        # opens Chrome with the bot's own profile; log in once, pick the account
```

Config, on top of the usual sections:

```json
"instrument": { "symbol": "NQ", "yahoo_symbol": "NQ=F", "tick_size": 0.25, "point_value": 1.0 },
"data": { "source": "vest_page", "interval": "1m", "lookback_days": 2 },
"broker": { "kind": "vest_browser",
            "vest_browser": { "market": "NQ-PERP", "channel": "chrome", "submit_orders": false, "max_notional_usd": 60000 } }
```

- `point_value` is 1.0: one unit of the Vest NQ perp is one index point per dollar. `risk.max_contracts` is in those units.
- `data.source: "vest_page"` builds real-time 1-minute bars from the page's mid price; older bars are a delayed
  Yahoo backfill shifted to the live price, used only to warm up indicators.
- `submit_orders: false` is a dry run: the form is filled and checked, a screenshot is saved in `state/`, nothing is
  clicked. Orders are submitted only with `submit_orders: true` **and** `"paper": false`; `mode: "auto"` then also
  needs `"i_accept_live_autonomous_risk": true`.
- Every entry is a market order with the stop-loss and target attached on the exchange, so the stop does not depend
  on this process staying up. The order is abandoned if the page's order value differs from the intended one by more
  than 2%, if the market is halted or closed, if you are logged out, or if a position Jarvis did not open is present.
- A close is a reduce-only market order. Moving a stop is not supported yet (the brain can close instead).

**Not yet verified with a logged-in account** (the adapter was written against the public page): the confirmation
dialog after submit, the positions-table row layout, and the reduce-only close. Each stops with an error and a
screenshot if the page does not behave as expected. Before letting it run: `vest-check`, then a dry run during
market hours, then one smallest-size trade with `submit_orders` on while you watch.

The computer must stay on, awake and logged in to Vest for the bot to run.

## Intel: what the brain sees besides price

Every decision also gets an `intel` block (`jarvis_core/intel.py`, on by default, all free public data):

- **Session direction call.** The first half-hour check from 10:00 to 15:30 New York where price is outside its
  normal range from the open for that time of day. It is the one input with a measured record, and the record is
  sent with it: right on direction 57% of the time, 63% when it agrees with the 50-day trend, 49% when it does not
  (731 sessions, 2023-01 to 2026-10). It picks the side; it is not an entry.
- **Macro snapshot:** VIX, 10-year yield, dollar, S&P futures, semiconductors, oil, gold, bitcoin, each with its
  change from the prior close.
- **Economic calendar:** today's and tomorrow's high-importance US releases with forecast and actual. A blackout
  from 10 minutes before to 15 minutes after each one is applied automatically by the risk layer.
- **News wire:** the latest FinancialJuice headlines, alongside the Yahoo headlines.

`"intel": {"require_with_trend_call": true}` makes the risk layer refuse any entry unless a session call has fired,
agrees with the 50-day trend, and points the same way as the entry.

`knowledge/playbook.vest.example.md` is a playbook written from the trader's own trade log and the backtests in
`desk/research/`. Copy it to `knowledge/playbook.md` and edit it.

`python3 jarvis.py stats` prints the record so far from the journal: trades, win rate, profit factor, drawdown.
Judge the brain on that, in paper mode, before any live order.

## The risk layer (deterministic, no model)

`jarvis_core/risk.py` blocks, with a reason, anything that breaks:

- trade windows, no-trade dates, weekend, event blackouts, the kill switch
- max contracts, max open positions (1), daily loss limit, daily trade limit,
  consecutive-loss limit, cooldown after a loss
- every entry must have a stop; stop width within min/max points; reward:risk
  floor; worst case for the order must fit the remaining daily loss room
- minimum brain confidence; prices on the tick grid

The kill switch is a file: `python3 jarvis.py stop` creates `jarvis/STOP`, the next
heartbeat flattens and the loop idles. `resume` removes it. `flatten_at` closes
everything at the configured time regardless of what the brain thinks.

## The brain

`jarvis_core/brain.py` makes one call per heartbeat that needs a decision
(default `claude-opus-5-5`, adaptive thinking, structured JSON output, server-side
refusal fallback on). It sees: the market picture (levels, VWAP, ATR, opening range,
overnight range, trend state, session phase, last 12 bars), headlines, your playbook
whole, the best-matching chunks of your other notes, the lessons from the last five
end-of-day reviews, the open position, the day so far, and the rules.

It returns one of `long / short / flat / hold / close / move_stop` with stop,
target, confidence, thesis, invalidation, a read of the crowd, and a self-check
naming the behavioural trap the decision is most exposed to. Heartbeats outside
the trade windows with no open position do not call the model at all.

## Knowledge: your files

Put them in `knowledge/`, run `ingest`. Folders and SQLite databases anywhere on
the machine can be indexed in place with `ingest --dir PATH` or
`knowledge.extra_dirs`. See `knowledge/README.md`.

## Journal and review

`state/` holds `state.json`, `decisions.jsonl`, `trades.jsonl`, `proposals.jsonl`,
and `reviews/`. `python3 jarvis.py review` writes a blunt end-of-day review, and its
Lessons section is injected into every decision for the next five sessions. That
is the learning loop, and it is honest: the agent reads what went wrong yesterday.

## Config reference

See `config.example.json`. Event blackouts are dates and times you maintain
(CPI, FOMC, NFP). `session.trade_windows` are ET. `instrument.point_value` is 20
for NQ, 2 for MNQ (set `yahoo_symbol` to `MNQ=F` and `tradovate_symbol` to the
MNQ contract).

## Tests

```bash
python3 -m unittest discover -s tests -v
```

Offline. They cover risk rules, the paper broker, levels, the knowledge index,
and the brain with a fake model.

## Not financial advice

This is software that reads public data and applies your rules. It can and will
lose money. Nothing here knows the future.
