import express from "express";
import { pool, withTransaction } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

// Full inbox for the logged-in user, newest first, with a per-user is_read
// flag joined in from notification_reads. v1 audience is always 'all', so
// every notification goes to every user — the WHERE clause is written
// against audience anyway so a real segment (e.g. 'vip') can be added later
// without touching this query's shape.
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.title, n.body, n.type, n.created_at,
              (nr.user_id IS NOT NULL) AS is_read
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.user_id = $1
       WHERE n.audience = 'all'
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ notifications: rows });
  } catch (err) {
    console.error("Get notifications error:", err);
    res.status(500).json({ error: "Could not fetch notifications." });
  }
});

// Just the unread count, for the bell badge — cheaper than fetching the
// full list on every poll.
router.get("/unread-count", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS count
       FROM notifications n
       WHERE n.audience = 'all'
         AND NOT EXISTS (
           SELECT 1 FROM notification_reads nr
           WHERE nr.notification_id = n.id AND nr.user_id = $1
         )`,
      [req.userId]
    );
    res.json({ count: Number(rows[0].count) });
  } catch (err) {
    console.error("Get unread count error:", err);
    res.status(500).json({ error: "Could not fetch unread count." });
  }
});

// Mark one notification read. Idempotent — reading it twice is a no-op,
// not an error, since the bell/inbox can call this any time it's opened.
router.post("/:id/read", async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO notification_reads (notification_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Mark notification read error:", err);
    res.status(500).json({ error: "Could not mark notification as read." });
  }
});

// Mark everything read at once — the inbox's "mark all read" action.
router.post("/read-all", async (req, res) => {
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO notification_reads (notification_id, user_id)
         SELECT n.id, $1 FROM notifications n
         WHERE n.audience = 'all'
         ON CONFLICT (notification_id, user_id) DO NOTHING`,
        [req.userId]
      );
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Mark all read error:", err);
    res.status(500).json({ error: "Could not mark notifications as read." });
  }
});

export default router;
