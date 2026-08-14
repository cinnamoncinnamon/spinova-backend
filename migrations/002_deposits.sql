-- Phase 1b: Deposit methods (admin-managed) + deposit requests (user submissions)

-- Stores the actual deposit numbers/addresses admin configures from the admin panel.
-- Admin can add multiple numbers per method, toggle them on/off, reorder them.
CREATE TABLE IF NOT EXISTS deposit_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  method VARCHAR(20) NOT NULL,         -- bkash, nagad, binance_pay, binance_usdt
  label VARCHAR(100) NOT NULL,         -- e.g. "bKash Personal", "Binance USDT TRC20"
  account_number VARCHAR(200) NOT NULL, -- phone number or crypto address
  min_amount DECIMAL(15,2) DEFAULT 50,
  max_amount DECIMAL(15,2) DEFAULT 50000,
  is_active BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 0,
  note VARCHAR(255),                   -- optional note shown to user e.g. "Send to personal number"
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- When a user wants to deposit, they send money to one of the above numbers
-- and submit a request here with their transaction ID as proof.
-- Admin approves/rejects from the admin panel, which credits the wallet.
CREATE TABLE IF NOT EXISTS deposit_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deposit_method_id UUID REFERENCES deposit_methods(id),
  method VARCHAR(20) NOT NULL,
  account_number VARCHAR(200) NOT NULL,  -- which number they sent to (snapshot)
  amount DECIMAL(15,2) NOT NULL,
  transaction_id VARCHAR(255) NOT NULL,  -- TxID / bKash TrxID the user submits
  status VARCHAR(20) DEFAULT 'pending',  -- pending, approved, rejected
  admin_note VARCHAR(255),               -- reason for rejection etc
  reviewed_by VARCHAR(100),              -- admin identifier
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_requests_user_id ON deposit_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_deposit_requests_status ON deposit_requests(status);
CREATE INDEX IF NOT EXISTS idx_deposit_methods_method ON deposit_methods(method);

-- Seed some default methods so the admin panel isn't empty on first run.
-- Admin can edit/delete these from the panel.
INSERT INTO deposit_methods (method, label, account_number, min_amount, max_amount, display_order, note)
VALUES
  ('bkash',         'bKash Personal',       '01700000000', 50,   50000,  1, 'Send Money → Personal'),
  ('nagad',         'Nagad Personal',        '01700000001', 50,   50000,  2, 'Send Money → Personal'),
  ('binance_pay',   'Binance Pay',           'SPINOVA2026', 500,  100000, 3, 'Search by Binance Pay ID'),
  ('binance_usdt',  'Binance USDT (TRC20)',  'TRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 500, 500000, 4, 'TRC20 network only')
ON CONFLICT DO NOTHING;
