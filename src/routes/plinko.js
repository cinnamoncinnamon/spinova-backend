/**
 * POST /api/plinko/play  { betAmount, risk?, balls? }
 * GET  /api/plinko/info
 * Server decides every path + bin. Client only animates.
 */
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import * as walletService from "../services/walletService.js";
import { isGameEnabled } from "../services/gameSettings.js";
import {
  GAME_ID,
  generateResult,
  isValidBet,
  isValidRisk,
  theoreticalRtp,
  getTables,
  BET_STEPS,
  ROWS,
  RISKS,
} from "../games/PlinkoEngine.js";

const router = express.Router();
router.use(requireAuth);

const MAX_BALLS = 8;

router.post("/play", async (req, res) => {
  try {
    if (!(await isGameEnabled(GAME_ID))) {
      return res.status(503).json({ error: "Plinko is currently unavailable." });
    }

    const betAmount = Number(req.body?.betAmount);
    const risk = req.body?.risk || "medium";
    const balls = Math.min(MAX_BALLS, Math.max(1, Math.floor(Number(req.body?.balls) || 1)));

    if (!isValidBet(betAmount)) {
      return res.status(400).json({ error: "Invalid bet amount.", allowed: BET_STEPS });
    }
    if (!isValidRisk(risk)) {
      return res.status(400).json({ error: "Invalid risk.", allowed: RISKS });
    }

    const userId = req.userId;
    const totalCost = Math.round(betAmount * balls * 100) / 100;

    let balanceAfterBet;
    try {
      balanceAfterBet = await walletService.placeBet({
        userId,
        amount: totalCost,
        game: GAME_ID,
        roundId: null,
      });
    } catch (err) {
      if (err.message === "Insufficient balance") {
        return res.status(400).json({ error: "Insufficient balance." });
      }
      throw err;
    }

    const results = [];
    let balance = balanceAfterBet;

    for (let i = 0; i < balls; i++) {
      const result = await generateResult({ risk });
      const winAmount = Math.round(betAmount * result.multiplier * 100) / 100;

      if (winAmount > 0) {
        balance = await walletService.creditWin({
          userId,
          amount: winAmount,
          game: GAME_ID,
          roundId: result.roundId,
        });
      }

      try {
        const { pool } = await import("../db/pool.js");
        await pool.query(
          `INSERT INTO game_rounds (id, game, period, result, result_data)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            result.roundId,
            GAME_ID,
            String(Date.now()),
            String(result.multiplier),
            JSON.stringify({
              binIndex: result.binIndex,
              path: result.path,
              risk: result.risk,
              betAmount,
              winAmount,
              rtp: result.rtp,
            }),
          ]
        );
      } catch (e) {
        console.error("Plinko audit insert failed:", e.message);
      }

      results.push({
        roundId: result.roundId,
        path: result.path,
        binIndex: result.binIndex,
        multiplier: result.multiplier,
        betAmount,
        winAmount,
        risk: result.risk,
      });
    }

    return res.json({ results, balance, risk, lines: ROWS, rtp: "96" });
  } catch (err) {
    console.error("Plinko play error:", err);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

router.get("/info", async (req, res) => {
  try {
    res.json({
      betSteps: BET_STEPS,
      lines: ROWS,
      risks: RISKS,
      theoreticalRtp: {
        low: theoreticalRtp("low"),
        medium: theoreticalRtp("medium"),
        high: theoreticalRtp("high"),
      },
      multipliers: getTables(),
      enabled: await isGameEnabled(GAME_ID),
    });
  } catch (err) {
    console.error("Plinko info error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

export default router;
