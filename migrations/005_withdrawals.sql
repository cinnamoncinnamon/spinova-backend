-- Real withdrawal flow, mirroring deposit_requests (002_deposits.sql).
--
-- Key difference from deposits: the wallet amount is deducted the moment the
-- user submits the request (see routes/withdrawal.js), not when admin
-- approves. That's deliberate — the funds have to be held immediately so a
-- player can't keep betting with money they've already asked to withdraw,
-- or submit several requests that together exceed their real balance.
-- If admin rejects, the held amount is refunded back to the wallet as a
-- 'refund' transaction; if approved, no further wallet change happens —
-- approval just records that the admin sent the money out manually via
-- bKash/Nagad/Binance and is a paper trail, same spirit as deposit_requests.
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method VARCHAR(20) NOT NULL,           -- bkash, nagad, binance_pay, binance_usdt
  account_details VARCHAR(200) NOT NULL, -- the user's OWN number/address to pay out to
  amount DECIMAL(15,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',  -- pending, approved, rejected
  admin_note VARCHAR(255),
  reviewed_by VARCHAR(100),
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_id ON withdrawal_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
