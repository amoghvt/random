-- Time series, latest quotes, small state, and one indexed document table per collection
-- in @desk/contracts Collections. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS candles (
  symbol text NOT NULL,
  tf     text NOT NULL,
  t      timestamptz NOT NULL,
  o double precision NOT NULL,
  h double precision NOT NULL,
  l double precision NOT NULL,
  c double precision NOT NULL,
  v double precision NOT NULL,
  source text NOT NULL,
  PRIMARY KEY (symbol, tf, t)
);

CREATE TABLE IF NOT EXISTS data (
  key         text NOT NULL,
  as_of       timestamptz NOT NULL,
  value       double precision NOT NULL,
  source      text NOT NULL,
  cadence_sec double precision NOT NULL,
  meta        jsonb,
  PRIMARY KEY (key, as_of)
);

CREATE TABLE IF NOT EXISTS quotes (
  symbol      text PRIMARY KEY,
  price       double precision NOT NULL,
  prev_close  double precision,
  change_pct  double precision,
  as_of       timestamptz NOT NULL,
  source      text NOT NULL,
  cadence_sec double precision NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  c text;
BEGIN
  FOREACH c IN ARRAY ARRAY[
    'headlines', 'calendar', 'catalysts', 'predictions', 'earnings', 'lagged_facts', 'structure_events',
    'watcher_updates', 'base_rates', 'bias_calls', 'account_states', 'positions', 'tickets',
    'guardrail_firings', 'notifications', 'briefs', 'notes', 'chat', 'rule_diffs'
  ] LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I (id text PRIMARY KEY, ts timestamptz NOT NULL, instrument text, status text, doc jsonb NOT NULL)', c);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (ts DESC)', c || '_ts_idx', c);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (instrument, ts DESC)', c || '_instrument_ts_idx', c);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (status, ts DESC)', c || '_status_ts_idx', c);
  END LOOP;
END $$;
