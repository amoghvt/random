/**
 * Every tunable guardrail threshold lives here. `tuneThresholds` proposes changes to this object;
 * nothing changes until the trader approves the weekly memo. Trader-set circuit breakers
 * (late-night window, plan-breaking trades per day, Vest claim percent, re-entry cooldown) live in profile.yaml.
 */
export interface Thresholds {
  /** A flush is a daily close down at least this percent versus the prior close. */
  flushDownPct: number;
  /** A long ticket inside this many hours of the flush close is a bottom call. */
  bottomCallWindowHours: number;
  /** A "bottom is in" message is checked against flushes this recent. */
  bottomCallPhraseLookbackHours: number;
  /** Size allowed before the confirmation day prints, as a fraction of the engine's survivable size. */
  bottomCallSizeFraction: number;
  /** Sessions searched for earlier flushes quoted as evidence. */
  flushLookbackSessions: number;
  /** New ticket notional above this multiple of the 20-trade median... */
  sizeCreepMultiple: number;
  /** ...within this many hours of a gain above this percent of the account. */
  sizeCreepWindowHours: number;
  sizeCreepGainPct: number;
  /** Fail price within this multiple of the 1-minute ATR is Critical. */
  thinFailAtrMultiple: number;
  thinFailRepeatMin: number;
  /** A retrace under this percent of the prior leg is a stalled bounce. */
  liquidityRunRetraceMaxPct: number;
  /** A spike_rejected event older than this is no longer "that candle". */
  squeezeEventMaxAgeMin: number;
  /** Structure events older than this are not quoted as current. */
  structureMaxAgeHours: number;
  /** Late-night misses in one night before a ticket is saved as a watch. */
  lateNightMissesBeforeWatch: number;
  /** A lagged fact older than this (days since its period end) gets its age stamped. */
  laggedFactStaleDays: number;
  /** Fairness: how far back the journal is read for correct reads and plan-followed winners. */
  acknowledgeLookbackDays: number;
  /** A guardrail that fires on nothing this many months running is retired. */
  retireAfterMonths: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  flushDownPct: 2,
  bottomCallWindowHours: 24,
  bottomCallPhraseLookbackHours: 120,
  bottomCallSizeFraction: 0.25,
  flushLookbackSessions: 30,
  sizeCreepMultiple: 1.5,
  sizeCreepWindowHours: 24,
  sizeCreepGainPct: 20,
  thinFailAtrMultiple: 1.5,
  thinFailRepeatMin: 5,
  liquidityRunRetraceMaxPct: 50,
  squeezeEventMaxAgeMin: 240,
  structureMaxAgeHours: 24,
  lateNightMissesBeforeWatch: 2,
  laggedFactStaleDays: 14,
  acknowledgeLookbackDays: 21,
  retireAfterMonths: 3,
};
