# 90-day replay: performance report

Run 2026-11-22 on recorded data. Command: `pnpm replay --days 90 --instruments NQ`. Raw output is reproduced from the CLI summary.

## Setup
- Window: 2026-08-22 to 2026-11-20. NQ went 29,388 → high 31,617 (Oct 6) → 25,127. A ~7.6% rally, then a ~20.5% fall.
- Resolution: 1h candles Aug 22 to Sep 11, 5m Sep 13 to Nov 13, 1m Nov 13 to Nov 20. 15-minute decision steps.
- Prices and releases are real. Only the timing is synthetic: the engines saw only data stamped before each step.
- Missing inputs: headlines, 2Y yield, Fed odds, options, CFTC, ETF flows. News and Fed factors scored zero throughout.
- Scores call direction at expiry. No trades, sizing or P&L.

## Bias engine
| | Resolved | Right | Hit rate |
|---|---|---|---|
| All directional calls | 2,793 | 1,305 | **46.7%** |
| Intraday | 1,244 | 631 | 50.7% |
| Swing (1-3 days) | 901 | 478 | 53.1% |
| Position (1-2 weeks) | 648 | 196 | **30.2%** |

Calls by label: Strong long 26, Lean long 923, No edge 3,400, Lean short 2,158, Strong short 371.

Calibration (predicted vs realized):
| Bucket | Predicted | Realized | n |
|---|---|---|---|
| 0.50-0.55 | 52.9% | 41.6% | 1,090 |
| 0.55-0.60 | 56.8% | 45.7% | 930 |
| 0.60-0.65 | 61.6% | 48.5% | 511 |
| 0.65-0.70 | 66.6% | 70.9% | 213 |
| 0.70-0.75 | 71.5% | 50.0% | 36 |
| 0.75-0.80 | 75.9% | 76.9% | 13 |

Verdict: no demonstrated edge. Overall it was worse than a coin flip, and its probabilities were overconfident in every bucket with a real sample except 0.65-0.70.

Caveats that make the numbers noisier than they look:
- **Call churn (a defect).** 6,812 of 6,878 calls were triggered by "level". The call changed roughly every other step, which breaks the spec's rule that a call never changes on the same evidence. Consecutive calls are highly correlated, so the effective sample is far smaller than 2,793. Fix before the long test.
- No split by direction yet. The position-horizon failure (30%) is unexplained until calls are broken down by direction and by date.
- One quarter, one instrument, one regime shape.

## Catalyst engine
11 Tier-1 releases. The matrix written the night before contained the realized branch in 10; the Oct 29 FOMC hold could not be resolved without a tone read.

Containing the branch is guaranteed by construction (branches cover every outcome), so it is not evidence of skill. The test is the probability the matrix gave the outcome that happened:

| Release | Realized | Probability given |
|---|---|---|
| NFP Sep 4 | Big beat | 11% |
| PPI Sep 10 | In line | 37% |
| CPI Sep 11 | Hot | 17% |
| FOMC Sep 16 | Hike | 10% |
| NFP Oct 2 | Miss | 9% |
| CPI Oct 14 | Hot | 20% |
| PPI Oct 15 | Very hot | 9% |
| NFP Nov 6 | Big beat | 14% |
| CPI Nov 10 | Hot | 20% |
| PPI Nov 13 | In line | 41% |

Eight of ten realized outcomes were given 20% or less. Prints ran hot repeatedly and the matrices, centered on consensus, kept underweighting that. The branch trades' P&L was not measured.

## Watcher base rates (setup follows through)
| Pattern | NQ 15m | NQ 1h | ES 15m | RTY 15m | YM 15m |
|---|---|---|---|---|---|
| Sweep and reclaim | 45.9% (726) | 45.3% (234) | 47.5% (781) | 44.9% (793) | 45.7% (757) |
| Bounce stalled under 50% | 53.3% (30) | 61.5% (13) | 46.7% (30) | 40.7% (27) | 51.5% (33) |

Sweep-and-reclaim failed more often than it worked on every equity index. The others have samples too small to read.

## What this means
- Do not size anything off the bias engine's probabilities yet.
- The calibration map built from this run will pull most calls toward 0.50.
- Next: fix the churn defect, add a by-direction and by-date breakdown, then run 2.4 years on 1h/4h with walk-forward testing (fit on the earlier part, score on the later part only).
