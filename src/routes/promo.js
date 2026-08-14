import express from "express";
import { withTransaction } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import * as walletService from "../services/walletService.js";

const router = express.Router();

router.use(requireAuth);

// Redeem a promo code. Everything — locking the code row, checking it's
// still valid, checking this user hasn't already redeemed it, crediting the
// wallet, recording the redemption, and bumping used_count — happens in one
// transaction, so two simultaneous redeem attempts (same user double-
// tapping, or a max_uses code being hit by many users at once) can't both
// succeed past the limit.
router.post("/redeem", async (req, res) => {
  const rawCode = String(req.body.code || "").trim().toUpperCase();
  if (!rawCode) {
    return res.status(400).json({ error: "Enter a code." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM promo_codes WHERE code = $1 FOR UPDATE`,
        [rawCode]
      );
      const promo = rows[0];
      if (!promo) throw new Error("NOT_FOUND");
      if (promo.status !== "active") throw new Error("INACTIVE");
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) throw new Error("EXPIRED");
      if (promo.max_uses !== null && promo.used_count >= promo.max_uses) throw new Error("MAX_USES");

      const { rows: existing } = await client.query(
        `SELECT 1 FROM promo_redemptions WHERE promo_code_id = $1 AND user_id = $2`,
        [promo.id, req.userId]
      );
      if (existing.length > 0) throw new Error("ALREADY_REDEEMED");

      const amount = Number(promo.amount);
      const balanceAfter = await walletService.creditBonus(
        { userId: req.userId, amount },
        client
      );

      await client.query(
        `INSERT INTO promo_redemptions (promo_code_id, user_id, amount) VALUES ($1, $2, $3)`,
        [promo.id, req.userId, amount]
      );
      await client.query(
        `UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1`,
        [promo.id]
      );

      return { amount, balanceAfter };
    });

    res.json({
      message: `৳${result.amount.toFixed(2)} bonus credited!`,
      amount: result.amount,
      balance: result.balanceAfter,
    });
  } catch (err) {
    const map = {
      NOT_FOUND: "That code doesn't exist.",
      INACTIVE: "This code is no longer active.",
      EXPIRED: "This code has expired.",
      MAX_USES: "This code has reached its usage limit.",
      ALREADY_REDEEMED: "You've already redeemed this code.",
    };
    if (map[err.message]) return res.status(400).json({ error: map[err.message] });
    console.error("Redeem promo error:", err);
    res.status(500).json({ error: "Could not redeem code." });
  }
});

export default router;
