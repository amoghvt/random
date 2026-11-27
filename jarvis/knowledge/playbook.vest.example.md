# Playbook for the Vest NQ perp (copy to playbook.md)

Built from the trader's own log (1,136 trades, Oct 7 to Nov 24 2026, net -$85,931) and from backtests on
3 years of 1-minute Nasdaq data. Numbers are quoted so the reason for each rule travels with it.

## What made the money
- 31 trades made +$85,048. They were with-trend entries taken after price had already turned: a pullback that held,
  or a failed bounce, in New York cash hours after 10:00, on the first attempt.
- A shallow sweep of a prior swing (under 15 points) followed by a 5-minute close back through it, in the direction of
  the trend, reached 2R 69% of the time (55 cases, 10 weeks). This is the best entry on record. It is a small sample.

## What lost the money (do not do these)
- 596 trades were stopped inside two minutes and lost $104,750: entering before price had turned.
- Trades outside 09:30 to 16:00 New York lost $69,844. Do not trade outside cash hours.
- Everything that was not NQ lost $35,021. NQ only.
- Longs during a falling market lost $64,348. Never against the 50-day trend and the 15-minute 200 EMA together.
- Re-entries after a stop lost $29,017. One attempt per idea. A second attempt needs a new 5-minute close confirming
  the level again, not price merely returning to it.
- A day that reached +$6,000 was given back to +$1,500. After a day is up $2,000, one more trade, then stop.

## Direction
- Use the session call in the intel block. Trade only in its direction, and only when it agrees with the 50-day
  trend. No call by 11:30 means a range day: stand aside unless the shallow-sweep setup appears at a clear level.
- The call is right about direction 63% of the time with the trend, and price usually goes 65 points against it
  before the close. Never enter on the call itself with a tight stop: wait for the entry below.

## When news takes over
- A fresh high-impact catalyst (a surprise data print, a Trump statement on tariffs, the Fed or the market, a Fed
  decision, a military strike) outranks the session call and the trend. No confluence is needed.
- Trade the confirmed reaction, not the headline: wait for the first push to pause and the first pullback to hold,
  then enter in the direction of the reaction. Stop beyond the pullback or the pre-news price.
- If price has already run far by the time you see it, the chasers are the exit liquidity: stand aside.
- Evidence so far: trading every Tier-1 release branch at full size lost $14,800 across 59 releases; sized to the
  plan's stop it was about break-even. The edge, if any, is in picking the few that are real surprises.

## The entry
1. Call fired, agrees with the trend.
2. Price pulls back against the call and stops: a swing forms, or a prior swing is swept by less than 15 points.
3. A 5-minute bar closes back in the direction of the call.
4. Enter. Stop 2 to 3 points beyond the pullback extreme. If that is more than 40 points away, no trade.
5. No fixed 2R target: in testing every fixed-target version lost. Take half at 2R if it comes, and hold the rest to
   15:55 with the stop moved to the entry once price is 1.5R in favour.

## Size
- Size so the stop costs at most a quarter of the remaining drawdown room. Full size only when the stop is under
  15 points and steps 1 to 3 are all present.

## Honest expectation
- Mechanical versions of this playbook were about break-even over 3 years. Whatever edge exists is in reading step 2
  and 3 well and in skipping the days that do not qualify. Most days should end with no trade.

## Tone
- Short. Level, reason, invalidation. If there is nothing to do, say "nothing to do".
