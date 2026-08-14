-- Real promo codes + direct admin gifts, replacing the fully-mocked
-- Promotions admin page. Both credit the wallet through the existing
-- 'bonus' transaction type in walletService.adjustBalance — no new
-- wallet-crediting logic, just new things that trigger it.
--
-- v1 is flat-amount codes only (redeem code -> instant ৳X credit). A
-- percentage-of-next-deposit code type would need to hook into the deposit
-- approval flow to know which deposit it applies to and expire correctly —
-- real design work of its own, deliberately left for a later phase rather
-- than half-built now.
CREATE TABLE IF NOT EXISTS promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(30) UNIQUE NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  max_uses INTEGER,              -- NULL = unlimited
  used_count INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active', -- active, inactive (manually toggled off)
  expires_at TIMESTAMP,          -- NULL = never expires
  created_by VARCHAR(100) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT NOW()
);

-- One row per successful redemption. The UNIQUE constraint is what actually
-- enforces "one redemption per user per code" — not application logic that
-- could race under concurrent requests.
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(15,2) NOT NULL,
  redeemed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (promo_code_id, user_id)
);

-- Direct instant credits an admin sends to one specific user, no code
-- involved (the "Gift User" flow). Kept separate from promo_redemptions
-- since it has no code and needs its own reason/admin-identity fields.
CREATE TABLE IF NOT EXISTS admin_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DECIMAL(15,2) NOT NULL,
  reason VARCHAR(255),
  created_by VARCHAR(100) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_gifts_user ON admin_gifts(user_id);
