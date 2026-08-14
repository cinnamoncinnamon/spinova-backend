import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import * as walletService from "../services/walletService.js";

const router = express.Router();

// All wallet routes require a logged-in user. The server reads balance
// from the DB using req.userId from the verified JWT — it never trusts
// any balance/amount the client claims about itself.
router.use(requireAuth);

router.get("/balance", async (req, res) => {
  try {
    const balance = await walletService.getBalance(req.userId);
    res.json({ balance });
  } catch (err) {
    console.error("Get balance error:", err);
    res.status(500).json({ error: "Could not fetch balance." });
  }
});

router.get("/transactions", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { rows } = await pool.query(
      `SELECT id, type, amount, balance_before, balance_after, game, round_id, status, created_at
       FROM transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.userId, limit]
    );
    res.json({ transactions: rows });
  } catch (err) {
    console.error("Get transactions error:", err);
    res.status(500).json({ error: "Could not fetch transaction history." });
  }
});

// Phase 1 dev/test shortcut — NOT the real deposit flow. Real deposits go
// through POST /api/deposit/request (admin-reviewed, see routes/deposit.js).
// This route exists purely so the wallet system could be exercised
// end-to-end before Phase 5 (Toripay) exists, and it was left reachable in
// every environment with zero payment verification — meaning any logged-in
// player could credit their own wallet up to ৳1,000,000 with one API call,
// completely bypassing admin approval. Gated to non-production until Toripay
// (webhook-verified) replaces it — do not remove this gate without replacing
// the route's authorization model first.
function blockInProduction(req, res, next) {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "This endpoint is disabled in production. Use /api/deposit/request." });
  }
  next();
}

router.post("/deposit", blockInProduction, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res.status(400).json({ error: "Invalid deposit amount." });
  }

  try {
    const balance = await walletService.recordDeposit({ userId: req.userId, amount });
    res.json({ balance });
  } catch (err) {
    console.error("Deposit error:", err);
    res.status(500).json({ error: "Deposit failed." });
  }
});

router.post("/withdraw", blockInProduction, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid withdrawal amount." });
  }

  try {
    const balance = await walletService.recordWithdraw({ userId: req.userId, amount });
    res.json({ balance });
  } catch (err) {
    if (err.message === "Insufficient balance") {
      return res.status(400).json({ error: "Insufficient balance." });
    }
    console.error("Withdraw error:", err);
    res.status(500).json({ error: "Withdrawal failed." });
  }
});

export default router;
