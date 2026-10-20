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

Put them in `knowledge/`, run `ingest`. See `knowledge/README.md`.

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
