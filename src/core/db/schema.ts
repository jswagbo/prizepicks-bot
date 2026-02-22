/**
 * The Fund — SQLite Database Schema
 * 
 * This file defines all database tables and their creation SQL.
 * Run migrations via: npm run db:migrate
 */

export const SCHEMA_VERSION = 5;

export const CREATE_TABLES_SQL = `
-- =============================================================================
-- Schema Version Tracking
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- Treasury
-- =============================================================================

CREATE TABLE IF NOT EXISTS treasury (
  id TEXT PRIMARY KEY DEFAULT 'main',
  total_capital REAL NOT NULL DEFAULT 0,
  available_capital REAL NOT NULL DEFAULT 0,
  allocated_capital REAL NOT NULL DEFAULT 0,
  reserve_minimum REAL NOT NULL DEFAULT 100,
  last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS treasury_transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'withdraw', 'allocate', 'deallocate', 'sweep')),
  amount REAL NOT NULL,
  pod_id TEXT,
  description TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pod_id) REFERENCES pods(id)
);

-- =============================================================================
-- Pods (Strategy Schools)
-- =============================================================================

CREATE TABLE IF NOT EXISTS pods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  strategy_type TEXT NOT NULL CHECK (strategy_type IN (
    'redemption_arbitrage',
    'complement_arbitrage',
    'exhaustive_coverage',
    'dead_market_farming',
    'late_stage_convergence',
    'sports_convergence',
    'sports_volatility'
  )),
  status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('active', 'paused', 'sandboxed', 'retired')),
  
  -- LLM Configuration
  llm_provider TEXT NOT NULL DEFAULT 'anthropic' CHECK (llm_provider IN ('anthropic', 'openai', 'grok')),
  llm_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  
  -- Capital Limits
  capital_cap REAL NOT NULL DEFAULT 1000,
  per_trade_max REAL NOT NULL DEFAULT 100,
  
  -- Price Bounds
  min_buy_price REAL NOT NULL DEFAULT 0.01,
  max_buy_price REAL NOT NULL DEFAULT 0.99,
  
  -- Metadata
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pod_state (
  pod_id TEXT PRIMARY KEY,
  allocated_capital REAL NOT NULL DEFAULT 0,
  deployed_capital REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  violation_count INTEGER NOT NULL DEFAULT 0,
  last_trade_at TEXT,
  FOREIGN KEY (pod_id) REFERENCES pods(id)
);

CREATE TABLE IF NOT EXISTS pod_allocations (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  amount REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('allocate', 'deallocate')),
  reason TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pod_id) REFERENCES pods(id)
);

-- =============================================================================
-- Market Allowlists
-- =============================================================================

CREATE TABLE IF NOT EXISTS market_allowlist (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  market_slug TEXT,
  market_question TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  added_by TEXT,
  FOREIGN KEY (pod_id) REFERENCES pods(id),
  UNIQUE (pod_id, condition_id)
);

-- =============================================================================
-- Proposals
-- =============================================================================

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  
  -- Action details
  action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'redeem')),
  condition_id TEXT NOT NULL,
  market_slug TEXT,
  market_question TEXT,
  outcome TEXT CHECK (outcome IN ('YES', 'NO')),
  price REAL NOT NULL,
  size REAL NOT NULL,
  
  -- LLM output
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL,
  
  -- Validation result
  accepted INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  validation_errors TEXT,  -- JSON array
  
  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  
  FOREIGN KEY (pod_id) REFERENCES pods(id)
);

-- =============================================================================
-- Trades (Canonical Trade Log)
-- =============================================================================

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  
  -- Market info
  condition_id TEXT NOT NULL,
  market_slug TEXT,
  market_question TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('YES', 'NO')),
  
  -- Trade details
  action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'redeem')),
  requested_price REAL NOT NULL,
  executed_price REAL NOT NULL,
  requested_size REAL NOT NULL,
  executed_size REAL NOT NULL,
  
  -- Costs
  total_cost REAL NOT NULL,
  fees REAL NOT NULL DEFAULT 0,
  
  -- Status
  status TEXT NOT NULL CHECK (status IN ('pending', 'executed', 'failed', 'cancelled')),
  error_message TEXT,
  
  -- Execution mode
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('paper', 'live')),
  
  -- Timestamps
  proposed_at TEXT NOT NULL,
  executed_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY (proposal_id) REFERENCES proposals(id),
  FOREIGN KEY (pod_id) REFERENCES pods(id)
);

-- =============================================================================
-- Ledger (Double-Entry Accounting)
-- =============================================================================

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'trade_buy',
    'trade_sell', 
    'trade_redeem',
    'capital_allocate',
    'capital_deallocate',
    'fee',
    'pnl_realized'
  )),
  pod_id TEXT,
  trade_id TEXT,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  balance REAL NOT NULL,
  description TEXT NOT NULL,
  metadata TEXT,  -- JSON object
  
  FOREIGN KEY (pod_id) REFERENCES pods(id),
  FOREIGN KEY (trade_id) REFERENCES trades(id)
);

-- =============================================================================
-- Positions (Current Holdings)
-- =============================================================================

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('YES', 'NO')),
  
  -- Position details
  quantity REAL NOT NULL DEFAULT 0,
  average_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  
  -- Status
  is_open INTEGER NOT NULL DEFAULT 1,
  
  -- Timestamps
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  
  FOREIGN KEY (pod_id) REFERENCES pods(id),
  UNIQUE (pod_id, condition_id, outcome)
);

-- =============================================================================
-- Daily Reports
-- =============================================================================

CREATE TABLE IF NOT EXISTS daily_reports (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD
  
  -- Treasury summary
  treasury_start REAL NOT NULL,
  treasury_end REAL NOT NULL,
  net_change REAL NOT NULL,
  
  -- Aggregate stats
  total_trades INTEGER NOT NULL DEFAULT 0,
  total_volume REAL NOT NULL DEFAULT 0,
  total_realized_pnl REAL NOT NULL DEFAULT 0,
  
  -- Pod reports (JSON array)
  pod_reports TEXT NOT NULL,
  
  -- Narrative
  summary TEXT NOT NULL,
  
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- Sweep Operations (Solana → Polygon Bridge)
-- =============================================================================

CREATE TABLE IF NOT EXISTS sweep_operations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'scheduled', 'checking', 'swapping', 'bridging', 'confirming', 
    'completed', 'failed', 'skipped'
  )),
  
  -- Source (Solana)
  solana_wallet TEXT NOT NULL,
  sol_balance_before REAL,
  sweep_percentage REAL NOT NULL,
  sweep_amount_sol REAL,
  
  -- Swap (Jupiter)
  swap_tx_hash TEXT,
  usdc_received REAL,
  swap_rate REAL,
  
  -- Bridge (deBridge)
  bridge_order_id TEXT,
  bridge_tx_hash TEXT,
  
  -- Destination (Polygon)
  polygon_recipient TEXT NOT NULL,
  usdc_bridged REAL,
  
  -- Fees
  solana_gas_fee REAL,
  jupiter_fee REAL,
  debridge_fee REAL,
  total_fees REAL,
  
  -- Timestamps
  scheduled_at TEXT,
  started_at TEXT,
  swap_completed_at TEXT,
  bridge_submitted_at TEXT,
  completed_at TEXT,
  
  -- Error handling
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bridge_status (
  id TEXT PRIMARY KEY,
  sweep_operation_id TEXT NOT NULL,
  debridge_order_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  source_tx_hash TEXT,
  destination_tx_hash TEXT,
  last_checked_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (sweep_operation_id) REFERENCES sweep_operations(id)
);

-- =============================================================================
-- Sports Convergence Positions
-- =============================================================================

CREATE TABLE IF NOT EXISTS sports_convergence_positions (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  market_slug TEXT,
  market_question TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('YES', 'NO')),
  clob_token_id TEXT NOT NULL,

  -- Entry
  entry_price REAL NOT NULL,
  entry_size REAL NOT NULL,
  entry_cost REAL NOT NULL,
  entry_time TEXT NOT NULL,
  entry_trade_id TEXT,

  -- Exit (null until closed)
  exit_price REAL,
  exit_proceeds REAL,
  exit_time TEXT,
  exit_trade_id TEXT,
  exit_reason TEXT CHECK (exit_reason IN ('target_reached', 'market_resolved', 'manual', 'timeout')),

  -- P&L
  realized_pnl REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'expired', 'resolved')),

  -- Config snapshot
  entry_threshold REAL NOT NULL DEFAULT 0.90,
  exit_threshold REAL NOT NULL DEFAULT 0.99,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (pod_id) REFERENCES pods(id),
  FOREIGN KEY (entry_trade_id) REFERENCES trades(id),
  FOREIGN KEY (exit_trade_id) REFERENCES trades(id)
);

-- =============================================================================
-- Indexes for Performance
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_sports_convergence_pod_id ON sports_convergence_positions(pod_id);
CREATE INDEX IF NOT EXISTS idx_sports_convergence_status ON sports_convergence_positions(status);
CREATE INDEX IF NOT EXISTS idx_sports_convergence_condition_id ON sports_convergence_positions(condition_id);
CREATE INDEX IF NOT EXISTS idx_trades_pod_id ON trades(pod_id);
CREATE INDEX IF NOT EXISTS idx_trades_condition_id ON trades(condition_id);
CREATE INDEX IF NOT EXISTS idx_trades_executed_at ON trades(executed_at);
CREATE INDEX IF NOT EXISTS idx_proposals_pod_id ON proposals(pod_id);
CREATE INDEX IF NOT EXISTS idx_ledger_pod_id ON ledger_entries(pod_id);
CREATE INDEX IF NOT EXISTS idx_ledger_timestamp ON ledger_entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_positions_pod_id ON positions(pod_id);
CREATE INDEX IF NOT EXISTS idx_positions_condition_id ON positions(condition_id);
CREATE INDEX IF NOT EXISTS idx_market_allowlist_pod_id ON market_allowlist(pod_id);
CREATE INDEX IF NOT EXISTS idx_sweep_operations_status ON sweep_operations(status);
CREATE INDEX IF NOT EXISTS idx_sweep_operations_created_at ON sweep_operations(created_at);
CREATE INDEX IF NOT EXISTS idx_bridge_status_order_id ON bridge_status(debridge_order_id);

-- =============================================================================
-- API Credentials (Cached Polymarket L2 Auth)
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_credentials (
  address TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  secret TEXT NOT NULL,
  passphrase TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- Bond Scanner Positions
-- =============================================================================

CREATE TABLE IF NOT EXISTS bond_scanner_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_id TEXT NOT NULL,
  question TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('YES', 'NO')),
  token_id TEXT NOT NULL,
  
  -- Entry details
  entry_price REAL NOT NULL,
  size REAL NOT NULL,
  
  -- LLM evaluation
  confidence REAL NOT NULL,
  reasoning TEXT NOT NULL,
  
  -- Execution
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('paper', 'live')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'resolved')),
  order_id TEXT,
  
  -- Exit (null until closed)
  exit_price REAL,
  exit_time TEXT,
  realized_pnl REAL,
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bond_scanner_status ON bond_scanner_positions(status);
CREATE INDEX IF NOT EXISTS idx_bond_scanner_condition ON bond_scanner_positions(condition_id);

-- =============================================================================
-- PrizePicks: Daily Picks
-- =============================================================================

CREATE TABLE IF NOT EXISTS prizepicks_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  player_name TEXT NOT NULL,
  team TEXT,
  opponent TEXT,
  league TEXT NOT NULL,
  stat_type TEXT NOT NULL,
  line REAL NOT NULL,
  pick TEXT NOT NULL CHECK (pick IN ('OVER', 'UNDER')),
  confidence INTEGER NOT NULL,
  ev_estimate REAL,
  reasoning TEXT,
  last5_avg REAL,
  last10_avg REAL,
  season_avg REAL,
  matchup_grade TEXT,
  home_away TEXT CHECK (home_away IN ('home', 'away')),
  actual_result REAL,
  hit INTEGER,
  in_parlay INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_picks_date ON prizepicks_picks(date);
CREATE INDEX IF NOT EXISTS idx_picks_player ON prizepicks_picks(player_name);
CREATE INDEX IF NOT EXISTS idx_picks_hit ON prizepicks_picks(hit);

-- =============================================================================
-- PrizePicks: Line Movements (Sharp Money Tracking)
-- =============================================================================

CREATE TABLE IF NOT EXISTS line_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_name TEXT NOT NULL,
  stat_type TEXT NOT NULL,
  source TEXT NOT NULL,
  line REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  game_date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_line_movements_player ON line_movements(player_name, stat_type, game_date);

-- =============================================================================
-- PrizePicks: Player Game Logs Cache
-- =============================================================================

CREATE TABLE IF NOT EXISTS player_game_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_name TEXT NOT NULL,
  team TEXT,
  league TEXT NOT NULL,
  game_date TEXT NOT NULL,
  opponent TEXT,
  home_away TEXT,
  minutes REAL,
  points REAL,
  rebounds REAL,
  assists REAL,
  steals REAL,
  blocks REAL,
  turnovers REAL,
  three_pointers_made REAL,
  fantasy_score REAL,
  pts_rebs_asts REAL,
  stat_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gamelogs_player ON player_game_logs(player_name, league);
CREATE INDEX IF NOT EXISTS idx_gamelogs_date ON player_game_logs(game_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gamelogs_unique ON player_game_logs(player_name, game_date, league);

-- =============================================================================
-- PrizePicks: Team Defense Rankings Cache
-- =============================================================================

CREATE TABLE IF NOT EXISTS team_defense_rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team TEXT NOT NULL,
  league TEXT NOT NULL,
  stat_type TEXT NOT NULL,
  rank INTEGER,
  avg_allowed REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_defense_unique ON team_defense_rankings(team, league, stat_type);

-- =============================================================================
-- NBA: Team Pace Ratings Cache (from NBA.com stats API)
-- =============================================================================

CREATE TABLE IF NOT EXISTS team_pace_ratings (
  team TEXT PRIMARY KEY,
  pace REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- PrizePicks: Performance Tracking
-- =============================================================================

CREATE TABLE IF NOT EXISTS prizepicks_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  total_picks INTEGER,
  hits INTEGER,
  misses INTEGER,
  hit_rate REAL,
  parlay_hit INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- PrizePicks: Pick Results (Historical Hit Rate Tracking)
-- =============================================================================

CREATE TABLE IF NOT EXISTS pick_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  player_name TEXT NOT NULL,
  stat_type TEXT NOT NULL,
  pick_direction TEXT NOT NULL CHECK (pick_direction IN ('OVER', 'UNDER')),
  edge_bucket TEXT NOT NULL,
  hit INTEGER NOT NULL,
  line REAL,
  actual_result REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pick_results_stat ON pick_results(stat_type, edge_bucket);
CREATE INDEX IF NOT EXISTS idx_pick_results_date ON pick_results(date);
`;

/**
 * Initialize the database with schema
 */
export function getSchemaSQL(): string {
  return CREATE_TABLES_SQL;
}

