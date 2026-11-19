-- Engine V5 isolated D1 schema.
-- All timestamps are UTC Unix milliseconds unless a column says otherwise.
-- Do not apply this migration to the existing bot's databases.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exchanges (
  exchange_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_success_at_ms INTEGER,
  last_error_at_ms INTEGER,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS instruments (
  instrument_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES exchanges(exchange_id),
  native_symbol TEXT NOT NULL,
  unified_symbol TEXT NOT NULL,
  market_type TEXT NOT NULL CHECK (market_type IN ('spot','perpetual')),
  base_asset TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  settlement_asset TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  tick_size REAL,
  lot_size REAL,
  min_notional REAL,
  listing_time_ms INTEGER,
  last_seen_at_ms INTEGER NOT NULL,
  metadata_json TEXT,
  UNIQUE(exchange_id, native_symbol, market_type)
);
CREATE INDEX IF NOT EXISTS idx_instruments_unified_market
  ON instruments(unified_symbol, market_type, status);

CREATE TABLE IF NOT EXISTS scan_runs (
  run_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  scan_type TEXT NOT NULL,
  status TEXT NOT NULL,
  instruments_seen INTEGER NOT NULL DEFAULT 0,
  candidates_created INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_started ON scan_runs(started_at_ms DESC);

CREATE TABLE IF NOT EXISTS market_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  captured_at_ms INTEGER NOT NULL,
  price REAL,
  bid REAL,
  ask REAL,
  spread_bps REAL,
  volume_24h REAL,
  quote_volume_24h REAL,
  relative_volume REAL,
  volatility REAL,
  open_interest REAL,
  funding_rate REAL,
  basis_bps REAL,
  buy_taker_ratio REAL,
  depth_imbalance REAL,
  source_timestamp_ms INTEGER,
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  quality_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_instrument_time
  ON market_snapshots(instrument_id, captured_at_ms DESC);

CREATE TABLE IF NOT EXISTS opportunity_candidates (
  candidate_id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  detected_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  detector TEXT NOT NULL,
  stage TEXT NOT NULL,
  side_bias TEXT CHECK (side_bias IN ('long','short','both','unknown')),
  score REAL NOT NULL,
  rank_position INTEGER,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  rejection_reason TEXT,
  expires_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_candidates_status_score
  ON opportunity_candidates(status, score DESC, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_instrument_time
  ON opportunity_candidates(instrument_id, detected_at_ms DESC);

CREATE TABLE IF NOT EXISTS strategy_versions (
  strategy_version_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL CHECK (model_id IN ('A','B','PUMP')),
  version_label TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 1 CHECK (frozen IN (0,1)),
  UNIQUE(model_id, config_hash)
);

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  status TEXT NOT NULL,
  universe_config_json TEXT NOT NULL,
  execution_config_json TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  experiment_id TEXT REFERENCES experiments(experiment_id),
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(strategy_version_id),
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  decided_at_ms INTEGER NOT NULL,
  side TEXT CHECK (side IN ('long','short','none')),
  decision TEXT NOT NULL CHECK (decision IN ('signal','watch','reject','alert')),
  score REAL NOT NULL,
  entry_plan_json TEXT,
  feature_snapshot_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  source_snapshot_id TEXT REFERENCES market_snapshots(snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_decisions_experiment_time
  ON decisions(experiment_id, decided_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_instrument_time
  ON decisions(instrument_id, decided_at_ms DESC);

CREATE TABLE IF NOT EXISTS paper_trades (
  trade_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(decision_id),
  experiment_id TEXT REFERENCES experiments(experiment_id),
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(strategy_version_id),
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  entry_at_ms INTEGER,
  closed_at_ms INTEGER,
  entry_price REAL,
  average_exit_price REAL,
  stop_price REAL,
  targets_json TEXT NOT NULL,
  quantity REAL,
  gross_pnl REAL,
  fees REAL NOT NULL DEFAULT 0,
  funding_paid REAL NOT NULL DEFAULT 0,
  slippage_cost REAL NOT NULL DEFAULT 0,
  net_pnl REAL,
  initial_risk REAL,
  realized_r REAL,
  close_reason TEXT,
  fill_model_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_trades_model_status
  ON paper_trades(strategy_version_id, status, closed_at_ms);
CREATE INDEX IF NOT EXISTS idx_paper_trades_experiment
  ON paper_trades(experiment_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS paper_trade_events (
  event_id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES paper_trades(trade_id),
  event_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  price REAL,
  quantity REAL,
  fee REAL NOT NULL DEFAULT 0,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_trade_events_trade_time
  ON paper_trade_events(trade_id, event_at_ms);

CREATE TABLE IF NOT EXISTS pump_events (
  pump_event_id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  first_detected_at_ms INTEGER NOT NULL,
  event_window_end_ms INTEGER,
  direction TEXT CHECK (direction IN ('up','down','unknown')),
  detection_stage TEXT NOT NULL,
  reference_price REAL,
  peak_price REAL,
  trough_price REAL,
  max_move_pct REAL,
  lead_time_seconds INTEGER,
  detector_version TEXT NOT NULL,
  outcome_label TEXT,
  evidence_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pump_events_instrument_time
  ON pump_events(instrument_id, first_detected_at_ms DESC);

CREATE TABLE IF NOT EXISTS model_metrics (
  metric_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id),
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(strategy_version_id),
  calculated_at_ms INTEGER NOT NULL,
  sample_size INTEGER NOT NULL,
  closed_trades INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  win_rate REAL,
  net_pnl REAL,
  expectancy REAL,
  profit_factor REAL,
  max_drawdown REAL,
  average_r REAL,
  fees_total REAL,
  funding_total REAL,
  metrics_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_metrics_latest
  ON model_metrics(experiment_id, strategy_version_id, calculated_at_ms DESC);

CREATE TABLE IF NOT EXISTS exchange_events (
  event_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES exchanges(exchange_id),
  occurred_at_ms INTEGER NOT NULL,
  severity TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_exchange_events_time
  ON exchange_events(exchange_id, occurred_at_ms DESC);

INSERT OR IGNORE INTO schema_migrations(version, applied_at_ms)
VALUES ('0001_initial', CAST(strftime('%s','now') AS INTEGER) * 1000);
