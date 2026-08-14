-- Phase 2: game servers

-- Every round result is saved here BEFORE being broadcast to clients.
-- This is the audit trail that proves outcomes weren't changed after bets landed.
CREATE TABLE IF NOT EXISTS game_rounds (
  id UUID PRIMARY KEY,
  game VARCHAR(30) NOT NULL,       -- wingo, k3, crash, etc.
  period VARCHAR(50) NOT NULL,
  result VARCHAR(100) NOT NULL,    -- winning number/multiplier etc.
  result_data JSONB,               -- full result details
  created_at TIMESTAMP DEFAULT NOW()
);

-- Admin game control settings (set from admin panel Game Controls page)
-- These are read by the game servers when generating outcomes.
CREATE TABLE IF NOT EXISTS game_controls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id VARCHAR(50) NOT NULL,    -- e.g. wingo_30s, wingo_60s, crash
  key VARCHAR(50) NOT NULL,        -- e.g. force_color, force_number, mode
  value VARCHAR(100) NOT NULL,     -- e.g. Red, Random, 1.50
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(game_id, key)
);

CREATE INDEX IF NOT EXISTS idx_game_rounds_game ON game_rounds(game);
CREATE INDEX IF NOT EXISTS idx_game_rounds_created ON game_rounds(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_controls_game ON game_controls(game_id);
