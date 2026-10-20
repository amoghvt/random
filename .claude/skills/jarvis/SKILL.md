---
name: jarvis
description: >-
  Jarvis, the discretionary NQ trading agent in jarvis/. Use when the user says
  "jarvis", "run jarvis", "what does jarvis see", "brief me on NQ", "approve the
  trade", "flatten", "stop trading", "review today", "ingest my notes", or wants
  the agent's market picture, a proposal approved, or the kill switch toggled.
argument-hint: "[status|picture|brief|ask ...|tick|run|approve <id>|flatten|stop|resume|ingest|review]"
---

# Jarvis

The code lives in `jarvis/`. Run commands from that folder:

```bash
cd jarvis && python3 jarvis.py <command>
```

| command | what it does | needs API key |
| --- | --- | --- |
| `status` | mode, kill switch, day stats, position, pending proposals | no |
| `picture` | levels, VWAP, ATR, opening range, phase, last bars | no |
| `brief` | one brain read of the market, nothing placed | yes |
| `ask "..."` | a question over the live picture and the user's knowledge | yes |
| `tick [--force]` | one heartbeat | yes |
| `run` | the loop; leave it running in a terminal | yes |
| `approve <id>` | execute a pending proposal | no |
| `flatten` | close everything now | no |
| `stop` / `resume` | kill switch on / off | no |
| `ingest` | rebuild the knowledge index | no |
| `review [date]` | end-of-day review into state/reviews/ | yes |

Rules for this skill:
- Never change `mode` to `auto`, `paper` to false, or `i_accept_live_autonomous_risk` on the user's behalf. Those are theirs to set by hand in `jarvis/config.json`.
- Never remove the kill file for the user unless they say "resume".
- When reporting a proposal, show the id, side, stop, target, confidence, thesis and invalidation, then the approve command. Do not approve it yourself.
- If `config.json` is missing, copy `config.example.json` to it and say so.
- Keep the user's `knowledge/` files private; never print their contents in full.
