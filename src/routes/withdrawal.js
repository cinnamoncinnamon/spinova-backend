import express from "express";
import { pool, withTransaction } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { sanitize } from "../middleware/sanitize.js";
import * as walletService from "../services/walletService.js";
import { emitAdminEvent } from "../services/adminEvents.js";

const router = express.Router();

const VALID_METHODS = new Set(["bkash", "nagad", "binance_pay", "binance_usdt"]);
const MIN_WITHDRAW = 100;
const MAX_WITHDRAW = 50000;

router.use(requireAuth);

// User submits a withdrawal request — the amount is deducted from the
// wallet immediately, atomically, in the same transaction as the request
// row. Funds stay held until admin approves (paid out manually, no further
// wallet change) or rejects (refunded — see /:id/reject).
router.post("/request", async (req, res) => {
  const { method, account_details, amount } = req.body;

  if (!method || !VALID_METHODS.has(method) || !account_details || !amount) {
    return res.status(400).json({ error: "Please fill all fields." });
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "Invalid amount." });
  }
  if (parsedAmount < MIN_WITHDRAW) {
    return res.status(400).json({ error: `Minimum withdrawal is ৳${MIN_WITHDRAW}.` });
  }
  if (parsedAmount > MAX_WITHDRAW) {
    return res.status(400).json({ error: `Maximum withdrawal per request is ৳${MAX_WITHDRAW}.` });
  }

  const cleanDetails = sanitize(String(account_details));
  if (!cleanDetails || cleanDetails.length < 4) {
    return res.status(400).json({ error: "Invalid account details." });
  }

  try {
    const request = await withTransaction(async (client) => {
      // Reuses the same locked-transaction debit as every other balance
      // change (see walletService.adjustBalance) — throws "Insufficient
      // balance" itself if the wallet can't cover it, composed here with
      // the request insert so both happen or neither does.
      await walletService.recordWithdraw({ userId: req.userId, amount: parsedAmount }, client);

      const { rows } = await client.query(
        `INSERT INTO withdrawal_requests (user_id, method, account_details, amount)
         VALUES ($1, $2, $3, $4)
         RETURNING id, method, account_details, amount, status, created_at`,
        [req.userId, method, cleanDetails, parsedAmount]
      );
      return rows[0];
    });

    // Notify admins the instant a withdrawal request comes in, with the
    // request id so it can be approved/rejected directly (e.g. from Telegram).
    const { rows: userRows } = await pool.query(`SELECT mobile FROM users WHERE id = $1`, [req.userId]);
    emitAdminEvent("withdrawal_request", {
      requestId: request.id,
      userId: req.userId,
      mobile: userRows[0]?.mobile,
      amount: parsedAmount,
      method,
      accountDetails: cleanDetails,
    });

    res.status(201).json({
      message: "Withdrawal request submitted. Admin will review and send your payout shortly.",
      request,
    });
  } catch (err) {
    if (err.message === "Insufficient balance") {
      return res.status(400).json({ error: "Insufficient balance." });
    }
    console.error("Withdrawal request error:", err);
    res.status(500).json({ error: "Could not submit withdrawal request." });
  }
});

// User's own withdrawal request history
router.get("/requests", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, method, account_details, amount, status, admin_note, created_at
       FROM withdrawal_requests
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error("Get withdrawal requests error:", err);
    res.status(500).json({ error: "Could not fetch withdrawal history." });
  }
});

export default router;
