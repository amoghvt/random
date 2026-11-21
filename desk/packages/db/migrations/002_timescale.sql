-- Hypertables for the two time series. Skipped cleanly on plain Postgres (extension not installed,
-- not preloaded, or the role may not create it): the tables keep working as ordinary tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    RAISE NOTICE 'timescaledb is not available; candles and data stay plain tables';
    RETURN;
  END IF;
  BEGIN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'timescaledb could not be enabled (%); candles and data stay plain tables', SQLERRM;
    RETURN;
  END;
  PERFORM create_hypertable('candles', 't', chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('data', 'as_of', chunk_time_interval => INTERVAL '30 days', if_not_exists => TRUE, migrate_data => TRUE);
END $$;
