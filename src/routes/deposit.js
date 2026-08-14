import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { sanitize } from "../middleware/sanitize.js";
import * as walletService from "../services/walletService.js";
import { emitAdminEvent } from "../services/adminEvents.js";

const router = express.Router();

// ── Public: get active deposit methods ───────────────────────────────────────
// No auth needed — user needs to see deposit numbers before/during login
router.get("/methods", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, method, label, account_number, min_amount, max_amount, note
       FROM deposit_methods
       WHERE is_active = TRUE
       ORDER BY display_order ASC, created_at ASC`
    );
    res.json({ methods: rows });
  } catch (err) {
    console.error("Get deposit methods error:", err);
    res.status(500).json({ error: "Could not fetch deposit methods." });
  }
});

// ── Auth required below this line ─────────────────────────────────────────────
router.use(requireAuth);

// User submits a deposit request (sends txn ID as proof)
router.post("/request", async (req, res) => {
  const { deposit_method_id, amount, transaction_id } = req.body;

  if (!deposit_method_id || !amount || !transaction_id) {
    return res.status(400).json({ error: "Please fill all fields." });
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "Invalid amount." });
  }

  const cleanTxnId = sanitize(String(transaction_id));
  if (!cleanTxnId || cleanTxnId.length < 4) {
    return res.status(400).json({ error: "Invalid transaction ID." });
  }

  try {
    // Verify the deposit method exists and is active
    const { rows: methodRows } = await pool.query(
      `SELECT id, method, label, account_number, min_amount, max_amount
       FROM deposit_methods WHERE id = $1 AND is_active = TRUE`,
      [deposit_method_id]
    );
    const method = methodRows[0];
    if (!method) {
      return res.status(400).json({ error: "Invalid deposit method." });
    }

    if (parsedAmount < Number(method.min_amount)) {
      return res.status(400).json({ error: `Minimum deposit is ৳${method.min_amount}.` });
    }
    if (parsedAmount > Number(method.max_amount)) {
      return res.status(400).json({ error: `Maximum deposit is ৳${method.max_amount}.` });
    }

    // Check for duplicate transaction ID (prevent double submissions)
    const { rows: dupRows } = await pool.query(
      `SELECT id FROM deposit_requests WHERE transaction_id = $1`,
      [cleanTxnId]
    );
    if (dupRows.length > 0) {
      return res.status(409).json({ error: "This transaction ID has already been submitted." });
    }

    const { rows } = await pool.query(
      `INSERT INTO deposit_requests
        (user_id, deposit_method_id, method, account_number, amount, transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, status, created_at`,
      [req.userId, method.id, method.method, method.account_number, parsedAmount, cleanTxnId]
    );

    // Notify admins (Telegram + live feed) the instant a request comes in,
    // not just when it's approved — that's the whole point of a request queue.
    const { rows: userRows } = await pool.query(`SELECT mobile FROM users WHERE id = $1`, [req.userId]);
    emitAdminEvent("deposit_request", {
      requestId: rows[0].id,
      userId: req.userId,
      mobile: userRows[0]?.mobile,
      amount: parsedAmount,
      method: method.method,
      depositNumber: method.account_number,
      transactionId: cleanTxnId,
    });

    res.status(201).json({
      message: "Deposit request submitted! Admin will review and credit your wallet shortly.",
      request: rows[0],
    });
  } catch (err) {
    console.error("Deposit request error:", err);
    res.status(500).json({ error: "Could not submit deposit request." });
  }
});

// User's own deposit request history
router.get("/requests", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dr.id, dr.method, dr.amount, dr.transaction_id, dr.status,
              dr.admin_note, dr.created_at, dm.label, dm.account_number
       FROM deposit_requests dr
       LEFT JOIN deposit_methods dm ON dr.deposit_method_id = dm.id
       WHERE dr.user_id = $1
       ORDER BY dr.created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error("Get deposit requests error:", err);
    res.status(500).json({ error: "Could not fetch deposit history." });
  }
});

export default router;
