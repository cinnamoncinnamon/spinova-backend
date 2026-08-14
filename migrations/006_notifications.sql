-- Real notification system, replacing the fully-mocked admin Notifications
-- page. Broadcast model: one row per notification sent (not one row per
-- user), with a separate reads table tracking who's seen it — avoids a
-- fanout write to every user on every send, and scales the same way
-- whether there are 100 users or 100,000.
--
-- v1 only supports "all users" as the audience (see notifications.audience
-- column, always 'all' for now) — the mock UI's "VIP Users" / "Active
-- Players" segments aren't real yet since those tiers aren't tracked
-- anywhere in the schema. audience is still a column, not hardcoded,
-- so real segments can be added later without another migration.
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(150) NOT NULL,
  body VARCHAR(1000) NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'announcement', -- announcement, alert, promo
  audience VARCHAR(20) NOT NULL DEFAULT 'all',
  created_by VARCHAR(100) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads(user_id);
