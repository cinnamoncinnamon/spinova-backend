-- Self-service "forgot password" for rx8: each user gets a one-time
-- recovery code (shown once at registration, rotated on every successful
-- reset). We only ever store its bcrypt hash, same as the password itself.

ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash VARCHAR(255);
