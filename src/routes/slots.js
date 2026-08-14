import express from "express";
import { requireAuth } from "../middleware/auth.js";
import * as walletService from "../services/walletService.js";
import { isGameEnabled } from "../services/gameSettings.js";
import {
  spin,
  peekFreeSpinsRemaining,
  acquireSpinLock,
  releaseSpinLock,
  isValidBet as isValidGoldenRelicsBet,
} from "../games/slots/GoldenRelicsEngine.js";
import {
  spin as spinElementsFury,
  buyFeature as buyElementsFuryFeature,
  buyFeatureCost as elementsFuryBuyFeatureCost,
  peekFreeSpinsRemaining as peekElementsFuryFreeSpins,
  acquireSpinLock as acquireElementsFuryLock,
  releaseSpinLock as releaseElementsFuryLock,
  isValidBet as isValidElementsFuryBet,
} from "../games/slots/ElementsFuryEngine.js";
import {
  spinTombRaiders,
  resolveGambleTombRaiders,
  collectGambleTombRaiders,
  acquireSpinLock as acquireTRLock,
  releaseSpinLock as releaseTRLock,
  BET_STEPS as TR_BET_STEPS,
} from "../games/slots/TombRaidersEngine.js";

const router = express.Router();
router.use(requireAuth);

// ── Security fix: session-key scoping ───────────────────────────────────────
// Every engine's spin()/peekFreeSpinsRemaining()/lock functions treat their
// first argument as an opaque Redis key — they don't care what it is. The
// previous version passed the client-supplied `sessionId` straight through
// on its own. That's a real vulnerability: sessionId is client-controlled
// and was never checked against the authenticated user, but wallet credits
// DO use the verified req.userId. Two different accounts sending the same
// sessionId string would share the same free-spin/jackpot state in Redis —
// account A could accumulate free spins, then account B (or a colluding
// alt) sends a spin with the same sessionId and gets A's free spin credited
// to B's real wallet. No signature or ownership check stopped this.
//
// Fix: every place that used to pass `sessionId` alone to an engine now
// passes `gameKey(userId, sessionId)` instead — a composite key that ties
// the state to BOTH the verified account and the session. This preserves
// the original "resets on refresh" behavior (a new sessionId still starts
// fresh) while making it impossible for one account's game state to be
// reachable by another account's requests, since userId always comes from
// the verified JWT (req.userId), never from the request body.
function gameKey(userId, sessionId) {
  return `${userId}:${sessionId}`;
}

const GAME_HANDLERS = {
  goldenrelics: async ({ userId, sessionId, amount }) => {
    if (!isValidGoldenRelicsBet(amount)) {
      throw Object.assign(new Error("Invalid bet amount."), { status: 400 });
    }

    const key = gameKey(userId, sessionId);
    const gotLock = await acquireSpinLock(key);
    if (!gotLock) {
      throw Object.assign(new Error("Previous spin still processing."), { status: 429 });
    }

    try {
      const freeSpinsRemaining = await peekFreeSpinsRemaining(key);
      const inFreeSpins = freeSpinsRemaining > 0;

      let balance;
      if (!inFreeSpins) {
        // Real bet — deducted before the outcome is computed, same
        // principle as WinGo/K3/the crash games: the player is committed
        // before the server decides the result, never the other way round.
        balance = await walletService.placeBet({ userId, amount, game: "goldenrelics", roundId: sessionId });
      } else {
        balance = await walletService.getBalance(userId);
      }

      const result = await spin({ userId: key, bet: amount });

      const payout = (result.winAmount || 0) + (result.jackpotWon ? result.jackpotAmount : 0);
      if (payout > 0) {
        balance = await walletService.creditWin({ userId, amount: payout, game: "goldenrelics", roundId: sessionId });
      }

      // Derive scatter cell positions from the grid ourselves — the engine
      // only returns a count, but the frontend needs "col-row" keys to
      // spawn particle effects at each scatter's actual location.
      const scatterHits = [];
      for (let c = 0; c < result.grid.length; c++) {
        for (let r = 0; r < result.grid[c].length; r++) {
          if (result.grid[c][r] === "poseidon") scatterHits.push(`${c}-${r}`);
        }
      }

      return {
        grid: result.grid,
        wins: result.wins,
        winTotal: result.winAmount,
        scatterHits,
        inFreeSpins,
        freeSpinsRemaining: result.freeSpinsRemaining,
        bonusAwarded: result.bonusTriggered
          ? { award: result.freeSpinsAwarded, retrigger: inFreeSpins }
          : null,
        jackpotWon: result.jackpotWon ? result.jackpotAmount : null,
        jackpot: result.jackpotCurrent,
        balance,
      };
    } finally {
      await releaseSpinLock(key);
    }
  },

  elementsfury: async ({ userId, sessionId, amount }) => {
    if (!isValidElementsFuryBet(amount)) {
      throw Object.assign(new Error("Invalid bet amount."), { status: 400 });
    }

    const key = gameKey(userId, sessionId);
    const gotLock = await acquireElementsFuryLock(key);
    if (!gotLock) {
      throw Object.assign(new Error("Previous spin still processing."), { status: 429 });
    }

    try {
      const freeSpinsRemaining = await peekElementsFuryFreeSpins(key);
      const inFreeSpins = freeSpinsRemaining > 0;

      let balance;
      if (!inFreeSpins) {
        balance = await walletService.placeBet({ userId, amount, game: "elementsfury", roundId: sessionId });
      } else {
        balance = await walletService.getBalance(userId);
      }

      const result = await spinElementsFury({ userId: key, bet: amount });

      if (result.winAmount > 0) {
        balance = await walletService.creditWin({ userId, amount: result.winAmount, game: "elementsfury", roundId: sessionId });
      }

      return {
        grid: result.grid,
        wins: result.wins,
        winTotal: result.winAmount,
        scatterCount: result.scatterCount,
        inFreeSpins,
        freeSpinsRemaining: result.freeSpinsRemaining,
        bonusAwarded: result.bonusTriggered
          ? { award: result.freeSpinsAwarded, retrigger: inFreeSpins, capped: result.bonusCapped }
          : null,
        streakMultiplier: result.streakMultiplier,
        freeSpinMult: result.freeSpinMult,
        balance,
      };
    } finally {
      await releaseElementsFuryLock(key);
    }
  },

  tombraiders: async ({ userId, sessionId, amount }) => {
    if (!TR_BET_STEPS.includes(amount)) {
      throw Object.assign(new Error("Invalid bet amount."), { status: 400 });
    }

    const key = gameKey(userId, sessionId);
    const gotLock = await acquireTRLock(key);
    if (!gotLock) {
      throw Object.assign(new Error("Previous spin still processing."), { status: 429 });
    }

    try {
      const result = await spinTombRaiders({ sessionId: key, bet: amount });

      let balance;
      if (!result.usingFreeSpin) {
        balance = await walletService.placeBet({ userId, amount, game: "tombraiders", roundId: sessionId });
      } else {
        balance = await walletService.getBalance(userId);
      }

      if (result.totalWin > 0) {
        balance = await walletService.creditWin({ userId, amount: result.totalWin, game: "tombraiders", roundId: sessionId });
      }

      return { ...result, balance };
    } finally {
      await releaseTRLock(key);
    }
  },
};

router.post("/spin", async (req, res) => {
  const { game, amount, sessionId } = req.body;

  const handler = GAME_HANDLERS[game];
  if (!handler) {
    return res.status(400).json({ error: `"${game}" is not available yet.` });
  }
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 100) {
    return res.status(400).json({ error: "Missing or invalid sessionId." });
  }
  const bet = Number(amount);
  if (!Number.isFinite(bet) || bet <= 0) {
    return res.status(400).json({ error: "Invalid bet amount." });
  }
  if (!(await isGameEnabled(game))) {
    return res.status(400).json({ error: "This game is currently unavailable." });
  }

  try {
    const result = await handler({ userId: req.userId, sessionId, amount: bet });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.message === "Insufficient balance") {
      return res.status(400).json({ error: "Insufficient balance." });
    }
    console.error("Slot spin error:", err);
    res.status(500).json({ error: "Spin failed." });
  }
});

// Gamble (double-or-nothing) — currently only Tomb Raiders has this feature.
// The coin flip happens here, server-side, using the pending amount tracked
// in Redis from the spin that offered it — never a client-supplied amount,
// and never decided in the browser (that was the actual vulnerability this
// migration exists to close). Same userId-scoped key fix applies here too.
router.post("/gamble/resolve", async (req, res) => {
  const { game, sessionId, pick } = req.body;
  if (game !== "tombraiders") {
    return res.status(400).json({ error: `Gamble is not available for "${game}".` });
  }
  if (pick !== "red" && pick !== "black") {
    return res.status(400).json({ error: "pick must be 'red' or 'black'." });
  }
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 100) {
    return res.status(400).json({ error: "Missing or invalid sessionId." });
  }

  const key = gameKey(req.userId, sessionId);

  try {
    const result = await resolveGambleTombRaiders({ sessionId: key, pick });
    let balance;
    if (result.delta > 0) {
      balance = await walletService.creditWin({ userId: req.userId, amount: result.delta, game: "tombraiders-gamble", roundId: sessionId });
    } else if (result.delta < 0) {
      balance = await walletService.placeBet({ userId: req.userId, amount: -result.delta, game: "tombraiders-gamble", roundId: sessionId });
    } else {
      balance = await walletService.getBalance(req.userId);
    }
    res.json({ ...result, balance });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("Gamble resolve error:", err);
    res.status(500).json({ error: "Gamble failed." });
  }
});

// Player chooses to walk away with the current gamble amount rather than
// risk it further — the amount was already credited to the wallet as a
// normal spin win, so this just clears the pending gamble state server-side.
router.post("/gamble/collect", async (req, res) => {
  const { game, sessionId } = req.body;
  if (game !== "tombraiders") {
    return res.status(400).json({ error: `Gamble is not available for "${game}".` });
  }
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 100) {
    return res.status(400).json({ error: "Missing or invalid sessionId." });
  }
  const key = gameKey(req.userId, sessionId);
  try {
    await collectGambleTombRaiders({ sessionId: key });
    res.json({ ok: true });
  } catch (err) {
    console.error("Gamble collect error:", err);
    res.status(500).json({ error: "Could not collect." });
  }
});

// Buy Feature — Elements Fury only. Pays BUY_FEATURE_COST_MULTIPLIER x bet
// to skip straight into a bonus round (the 4-scatter tier: 10 free spins),
// instead of waiting for a natural scatter trigger. Deliberately priced
// worse than natural-play RTP (see ElementsFuryEngine.js for the full
// pricing derivation) — same principle as a real slot's buy-a-bonus option.
router.post("/elements-fury/buy-feature", async (req, res) => {
  const userId = req.userId;
  const bet = Number(req.body.bet);
  const { sessionId } = req.body;

  if (!isValidElementsFuryBet(bet)) {
    return res.status(400).json({ error: "Invalid bet amount." });
  }
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 100) {
    return res.status(400).json({ error: "Missing or invalid sessionId." });
  }

  // Must match the exact key the player's regular /spin calls use for this
  // page session, or the free spins granted here would be invisible to the
  // next spin — the player would pay and the feature would silently vanish.
  const key = gameKey(userId, sessionId);

  const gotLock = await acquireElementsFuryLock(key);
  if (!gotLock) {
    return res.status(429).json({ error: "Previous spin still processing." });
  }

  try {
    // Fix: this check used to happen only inside buyElementsFuryFeature(),
    // AFTER the cost was already charged below — so a rejected purchase
    // (e.g. free spins already active from a natural trigger) still left
    // the player debited with nothing granted, no refund path. Checking
    // first means a rejection never touches the wallet.
    const alreadyActive = await peekElementsFuryFreeSpins(key);
    if (alreadyActive > 0) {
      return res.status(400).json({ error: "Cannot buy the feature while free spins are already active." });
    }

    const cost = elementsFuryBuyFeatureCost(bet);
    const balance = await walletService.getBalance(userId);
    if (balance < cost) {
      return res.status(400).json({ error: "Insufficient balance." });
    }

    // Charge the cost BEFORE granting the feature — same "player commits
    // first" principle used everywhere else, so a crash mid-request can
    // never grant free spins without the corresponding charge landing.
    const balanceAfterCharge = await walletService.placeBet({
      userId, amount: cost, game: "elementsfury-buyfeature", roundId: `buy-${sessionId}-${Date.now()}`,
    });

    const result = await buyElementsFuryFeature({ userId: key, bet });

    res.json({ ...result, balance: balanceAfterCharge });
  } catch (err) {
    console.error("Elements Fury buy-feature error:", err);
    res.status(400).json({ error: err.message || "Could not buy feature." });
  } finally {
    await releaseElementsFuryLock(key);
  }
});

export default router;