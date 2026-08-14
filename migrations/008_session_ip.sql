-- Adds IP tracking for multi-account / shared-device risk detection.
-- We deliberately do NOT use device_fingerprint for this — IP address and
-- shared payout details (see risk endpoints in admin.js) are used instead.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);

CREATE INDEX IF NOT EXISTS idx_sessions_ip ON sessions(ip_address);
