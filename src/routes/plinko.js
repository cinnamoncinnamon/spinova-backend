/**
 * Plinko HTTP routes.
 *
 * POST /api/plinko/play
 *   Body: { betAmount: number, lines?: number }
 *   Auth: required
 *
 * Flow:
 *   1. Validate bet + game enabled
 *   2. placeBet (lock money)
 *   3. generateResult (server decides bin)
 *   4. creditWin if multiplier > 0
 *   5. return result + new balance
 */

import express from "express";
import { requireAuth } from "../middleware/auth.js";
import * as walletService from "../services/walletService.js";
import { isGameEnabled } from "../services/gameSettings.js";
import {
  GAME_ID,
  generateResult,
  isValidBet,
  getPlinkoRtp,
  theoreticalRtp,
  BET_STEPS,
  DEFAULT_LINES,
  MIN_LINES,
  MAX_LINES,
} from "../games/PlinkoEngine.js";

const router = express.Router();
router.use(requireAuth);

/**
 * POST /api/plinko/play
 */
router.post("/play", async (req, res) => {
  try {
    if (!(await isGameEnabled(GAME_ID))) {
      return res.status(503).json({ error: "Plinko is currently unavailable." });
    }

    const betAmount = Number(req.body?.betAmount);
    const lines = Number(req.body?.lines) || DEFAULT_LINES;

    if (!isValidBet(betAmount)) {
      return res.status(400).json({
        error: "Invalid bet amount.",
        allowed: BET_STEPS,
      });
    }

    if (lines < MIN_LINES || lines > MAX_LINES) {
      return res.status(400).json({
        error: `Lines must be between ${MIN_LINES} and ${MAX_LINES}.`,
      });
    }

    const userId = req.userId;

    // 1. Deduct bet first (player is committed before result is known)
    let balanceAfterBet;
    try {
      balanceAfterBet = await walletService.placeBet({
        userId,
        amount: betAmount,
        game: GAME_ID,
        roundId: null, // will update conceptually via result.roundId
      });
    } catch (err) {
      if (err.message === "Insufficient balance") {
        return res.status(400).json({ error: "Insufficient balance." });
      }
      throw err;
    }

    // 2. Server decides the outcome
    const result = await generateResult({ lines });

    // 3. Credit win if any
    const winAmount = Math.round(betAmount * result.multiplier * 100) / 100;
    let balance = balanceAfterBet;

    if (winAmount > 0) {
      balance = await walletService.creditWin({
        userId,
        amount: winAmount,
        game: GAME_ID,
        roundId: result.roundId,
      });
    }

    // Optional: store round for audit (same pattern as other games)
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
            lines: result.lines,
            betAmount,
            winAmount,
            rtp: result.rtp,
          }),
        ]
      );
    } catch (e) {
      // Non-fatal — don't fail the play if audit insert has issues
      console.error("Plinko game_rounds insert failed:", e.message);
    }

    return res.json({
      roundId: result.roundId,
      betAmount,
      lines: result.lines,
      binIndex: result.binIndex,
      multiplier: result.multiplier,
      winAmount,
      balance,
      rtp: result.rtp,
    });
  } catch (err) {
    console.error("Plinko play error:", err);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

/**
 * GET /api/plinko/info
 * Public-ish info (still behind auth for simplicity) — bet steps, current RTP, etc.
 */
router.get("/info", async (req, res) => {
  try {
    const rtp = await getPlinkoRtp();
    res.json({
      betSteps: BET_STEPS,
      minLines: MIN_LINES,
      maxLines: MAX_LINES,
      defaultLines: DEFAULT_LINES,
      currentRtp: rtp,
      theoreticalRtp: theoreticalRtp(rtp),
      enabled: await isGameEnabled(GAME_ID),
    });
  } catch (err) {
    console.error("Plinko info error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

export default router;
