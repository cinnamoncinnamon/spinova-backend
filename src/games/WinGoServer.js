import { WebSocketServer } from "ws";
import { pool } from "../db/pool.js";
import { verifyAccessToken } from "../services/jwtService.js";
import { isBanned } from "../services/banCheck.js";
import { isGameEnabled } from "../services/gameSettings.js";
import * as walletService from "../services/walletService.js";
import { v4 as uuidv4 } from "uuid";

// Color map — matches the frontend NUM_COLORS
const NUM_COLORS = {
  0: ["red", "violet"],
  1: ["green"],
  2: ["red"],
  3: ["green"],
  4: ["red"],
  5: ["green", "violet"],
  6: ["red"],
  7: ["green"],
  8: ["red"],
  9: ["green"],
};

// Payout multipliers
const PAYOUTS = {
  number: 9,
  violet: 4.5,
  big: 2,
  small: 2,
  green: 2,
  red: 2,
};

// Round durations in seconds
const MODES = [30, 60, 180, 300];

// Small chance Minority/House rounds resolve randomly so outcomes aren't
// suspiciously perfect every single round (same idea as FXTrader).
const MINORITY_RANDOM_ESCAPE = 0.015;

// ── Admin control helpers ──────────────────────────────────────────────────

async function getGameControl(gameId, key, fallback) {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM game_controls WHERE game_id = $1 AND key = $2",
      [gameId, key]
    );
    return rows[0] ? rows[0].value : fallback;
  } catch {
    return fallback;
  }
}

async function clearForceKeys(gameId) {
  try {
    await pool.query(
      `DELETE FROM game_controls
       WHERE game_id = $1 AND key = 'force_number'`,
      [gameId]
    );
  } catch {
    // best-effort
  }
}

/**
 * Sum stakes that lean Big vs Small for the current round.
 * - big / small bets count fully
 * - number bets count toward the side of that number (0-4 Small, 5-9 Big)
 * - color bets are ignored for the axis decision (they still pay if they hit)
 */
function sumBigSmallStakes(betsMap) {
  let stakeBig = 0;
  let stakeSmall = 0;

  for (const userBets of betsMap.values()) {
    for (const bet of userBets) {
      const amt = Number(bet.amount) || 0;
      if (bet.type === "big") {
        stakeBig += amt;
      } else if (bet.type === "small") {
        stakeSmall += amt;
      } else if (bet.type === "number" && bet.value != null) {
        if (bet.value >= 5) stakeBig += amt;
        else stakeSmall += amt;
      }
      // green / red / violet intentionally not mapped onto big/small
    }
  }
  return { stakeBig, stakeSmall };
}

/**
 * Pick a winning number that lands on the requested side (Big or Small).
 * Prefer numbers that also respect an optional forced color if present.
 */
function pickNumberForSide(wantBig, preferColor = null) {
  const candidates = [];
  for (let n = 0; n <= 9; n++) {
    const isBig = n >= 5;
    if (isBig !== wantBig) continue;
    if (preferColor) {
      const colors = NUM_COLORS[n];
      if (!colors.includes(preferColor.toLowerCase())) continue;
    }
    candidates.push(n);
  }
  // Fallback: any number on that side
  if (candidates.length === 0) {
    for (let n = 0; n <= 9; n++) {
      if ((n >= 5) === wantBig) candidates.push(n);
    }
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}


const DEFAULT_HOUSE_EDGE = 3;
const DEFAULT_STAKE_THRESHOLD = 5000;
const DEFAULT_MAX_LIABILITY = 5000;
const AUTO_RISK_MINORITY_CHANCE = 0.7; // light book: 70% Minority, 30% Random(+edge)

/**
 * Estimate total payout if Big (or Small) wins this round.
 * big/small @ 2x, number bets on that side @ 9x. Color bets ignored (simpler Cap).
 */
function estimateSidePayout(betsMap, wantBig) {
  let total = 0;
  for (const userBets of betsMap.values()) {
    for (const bet of userBets) {
      const amt = Number(bet.amount) || 0;
      if (bet.type === "big" && wantBig) total += amt * (PAYOUTS.big || 2);
      else if (bet.type === "small" && !wantBig) total += amt * (PAYOUTS.small || 2);
      else if (bet.type === "number" && bet.value != null) {
        const isBig = bet.value >= 5;
        if (isBig === wantBig) total += amt * (PAYOUTS.number || 9);
      }
    }
  }
  return total;
}

function readNumericControl(raw, fallback, min, max) {
  if (raw === "" || raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function minorityResult(betsMap, soloWinRate) {
  const { stakeBig, stakeSmall } = sumBigSmallStakes(betsMap);
  const bothActive = stakeBig > 0 && stakeSmall > 0;

  if (Math.random() < MINORITY_RANDOM_ESCAPE) {
    return Math.floor(Math.random() * 10);
  }
  if (!bothActive) {
    if (stakeBig === 0 && stakeSmall === 0) return Math.floor(Math.random() * 10);
    const soloIsBig = stakeBig > 0;
    const soloWins = Math.random() < soloWinRate;
    return pickNumberForSide(soloWins ? soloIsBig : !soloIsBig);
  }
  let wantBig;
  if (stakeBig < stakeSmall) wantBig = true;
  else if (stakeSmall < stakeBig) wantBig = false;
  else wantBig = Math.random() < 0.5;
  return pickNumberForSide(wantBig);
}

/** Liability Cap: if one side's payout would exceed max, force the cheaper side. */
function liabilityCapResult(betsMap, maxLiability) {
  const payBig = estimateSidePayout(betsMap, true);
  const paySmall = estimateSidePayout(betsMap, false);
  if (payBig <= 0 && paySmall <= 0) return null;

  const bigOver = payBig >= maxLiability;
  const smallOver = paySmall >= maxLiability;
  if (bigOver && !smallOver) return pickNumberForSide(false);
  if (smallOver && !bigOver) return pickNumberForSide(true);
  if (bigOver && smallOver) return pickNumberForSide(payBig <= paySmall);
  return null;
}

/** House edge on Random: with edge% chance, majority stake loses. */
function randomWithHouseEdge(betsMap, houseEdgePercent) {
  const { stakeBig, stakeSmall } = sumBigSmallStakes(betsMap);
  if (houseEdgePercent > 0 && (stakeBig > 0 || stakeSmall > 0) && Math.random() < houseEdgePercent / 100) {
    if (stakeBig === 0) return pickNumberForSide(true);
    if (stakeSmall === 0) return pickNumberForSide(false);
    return pickNumberForSide(stakeBig < stakeSmall);
  }
  return Math.floor(Math.random() * 10);
}

/**
 * Core result generator:
 *   Auto Risk (default) → heavy book: Cap; light: 70% Minority / 30% Random+edge
 *   Liability Cap       → Cap only, else Random+edge
 *   Minority Wins       → lighter Big/Small wins
 *   Manual              → force_number one-shot
 *   Random              → pure / house-edge random
 */
async function generateResult(durationKey, betsMap) {
  const gameId = `wingo_${durationKey}`;
  const mode = await getGameControl(gameId, "mode", "Auto Risk");
  const forceNumber = await getGameControl(gameId, "force_number", "Random");
  const soloWinRate = readNumericControl(await getGameControl(gameId, "solo_win_rate", ""), 0.5, 0, 1);
  const houseEdge = readNumericControl(await getGameControl(gameId, "house_edge", ""), DEFAULT_HOUSE_EDGE, 0, 20);
  const stakeThreshold = readNumericControl(await getGameControl(gameId, "stake_threshold", ""), DEFAULT_STAKE_THRESHOLD, 1, 1e9);
  const maxLiability = readNumericControl(await getGameControl(gameId, "max_liability", ""), DEFAULT_MAX_LIABILITY, 1, 1e9);

  if (mode === "Manual") {
    if (forceNumber !== "Random") {
      const n = parseInt(forceNumber, 10);
      if (n >= 0 && n <= 9) {
        await clearForceKeys(gameId);
        return n;
      }
    }
    return Math.floor(Math.random() * 10);
  }

  if (mode === "Minority Wins") {
    return minorityResult(betsMap, soloWinRate);
  }

  if (mode === "Liability Cap") {
    const capped = liabilityCapResult(betsMap, maxLiability);
    if (capped != null) return capped;
    return randomWithHouseEdge(betsMap, houseEdge);
  }

  if (mode === "Auto Risk") {
    const { stakeBig, stakeSmall } = sumBigSmallStakes(betsMap);
    const total = stakeBig + stakeSmall;
    if (total >= stakeThreshold) {
      const capped = liabilityCapResult(betsMap, maxLiability);
      if (capped != null) return capped;
      return minorityResult(betsMap, soloWinRate);
    }
    if (Math.random() < AUTO_RISK_MINORITY_CHANCE) {
      return minorityResult(betsMap, soloWinRate);
    }
    return randomWithHouseEdge(betsMap, houseEdge);
  }

  return randomWithHouseEdge(betsMap, houseEdge);
}

// Calculate winnings for a bet given the result number
function calculateWin(bet, winNum) {
  const winColors = NUM_COLORS[winNum];
  let won = false;

  if (bet.type === "big" && winNum >= 5) won = true;
  if (bet.type === "small" && winNum <= 4) won = true;
  if (bet.type === "green" && winColors.includes("green")) won = true;
  if (bet.type === "red" && winColors.includes("red")) won = true;
  if (bet.type === "violet" && winColors.includes("violet")) won = true;
  if (bet.type === "number" && bet.value === winNum) won = true;

  if (!won) return 0;
  return bet.amount * (PAYOUTS[bet.type] || 2);
}

// Each mode runs its own independent round state
class WinGoMode {
  constructor(seconds) {
    this.seconds = seconds;
    this.key = `${seconds}s`;
    this.timeLeft = seconds;
    this.currentPeriod = this.generatePeriod();
    this.bets = new Map(); // userId -> [{ type, value, amount, roundId }]
    this.history = [];
    this.roundId = uuidv4();
    this.clients = new Set(); // ws clients subscribed to this mode
  }

  generatePeriod() {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(Math.floor(Date.now() / (this.seconds * 1000))).slice(-6)}`;
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  broadcastTo(ws, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  tick() {
    this.timeLeft--;
    this.broadcast({ type: "tick", timeLeft: this.timeLeft, period: this.currentPeriod });

    if (this.timeLeft <= 0) {
      this.endRound();
    }
  }

  async endRound() {
    // Pass the live bets map so Minority / House modes can see real stakes
    const winNum = await generateResult(this.key, this.bets);
    const winColors = NUM_COLORS[winNum];
    const bigSmall = winNum >= 5 ? "Big" : "Small";

    // Save result to DB
    try {
      await pool.query(
        `INSERT INTO game_rounds (id, game, period, result, result_data, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          this.roundId,
          "wingo",
          this.currentPeriod,
          winNum.toString(),
          JSON.stringify({ number: winNum, colors: winColors, bigSmall }),
        ]
      );
    } catch (err) {
      console.error("Failed to save round:", err.message);
    }

    // Process all bets
    const winners = [];
    for (const [userId, userBets] of this.bets.entries()) {
      let totalWin = 0;
      for (const bet of userBets) {
        const win = calculateWin(bet, winNum);
        totalWin += win;
      }
      if (totalWin > 0) {
        try {
          await walletService.creditWin({
            userId,
            amount: totalWin,
            game: "wingo",
            roundId: this.roundId,
          });
          winners.push({ userId, amount: totalWin });
        } catch (err) {
          console.error("Failed to credit win:", err.message);
        }
      }
    }

    // Broadcast result to all subscribers
    this.broadcast({
      type: "result",
      period: this.currentPeriod,
      number: winNum,
      colors: winColors,
      bigSmall,
      winners,
      roundId: this.roundId,
    });

    // Add to history
    this.history.unshift({
      period: this.currentPeriod,
      number: winNum,
      bigSmall,
      colors: winColors,
    });
    if (this.history.length > 50) this.history.pop();

    // Start next round
    this.bets.clear();
    this.timeLeft = this.seconds;
    this.currentPeriod = this.generatePeriod();
    this.roundId = uuidv4();

    this.broadcast({
      type: "new_round",
      period: this.currentPeriod,
      timeLeft: this.timeLeft,
      history: this.history.slice(0, 20),
    });
  }
}

export function createWinGoServer() {
  const wss = new WebSocketServer({ noServer: true });

  // Initialize all modes
  const modes = {};
  for (const sec of MODES) {
    modes[sec] = new WinGoMode(sec);
  }

  // Start global tick (1 second interval)
  setInterval(() => {
    for (const mode of Object.values(modes)) {
      mode.tick();
    }
  }, 1000);

  // Seed initial history for each mode
  async function seedHistory() {
    try {
      const { rows } = await pool.query(
        `SELECT period, result, result_data FROM game_rounds
         WHERE game = 'wingo' ORDER BY created_at DESC LIMIT 50`
      );
      for (const row of rows) {
        const data = row.result_data;
        for (const mode of Object.values(modes)) {
          if (mode.history.length < 20) {
            mode.history.push({
              period: row.period,
              number: parseInt(row.result),
              bigSmall: data.bigSmall,
              colors: data.colors,
            });
          }
        }
      }
    } catch {
      // No history yet, that's fine
    }
  }
  seedHistory();

  wss.on("connection", async (ws, req) => {
    let userId = null;
    let subscribedMode = null;

    ws.on("message", async (rawMsg) => {
      let msg;
      try {
        msg = JSON.parse(rawMsg);
      } catch {
        return;
      }

      // AUTH — must be first message
      if (msg.type === "auth") {
        try {
          const payload = verifyAccessToken(msg.token);
          if (await isBanned(payload.sub)) {
            ws.send(JSON.stringify({ type: "error", message: "This account has been suspended." }));
            ws.close();
            return;
          }
          userId = payload.sub;
          ws.send(JSON.stringify({ type: "auth_ok", userId }));
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
          ws.close();
        }
        return;
      }

      // SUBSCRIBE to a mode
      if (msg.type === "subscribe") {
        const sec = parseInt(msg.seconds);
        if (!modes[sec]) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid mode" }));
          return;
        }
        // Remove from previous mode
        if (subscribedMode) subscribedMode.clients.delete(ws);
        subscribedMode = modes[sec];
        subscribedMode.clients.add(ws);

        // Send current state
        ws.send(
          JSON.stringify({
            type: "state",
            period: subscribedMode.currentPeriod,
            timeLeft: subscribedMode.timeLeft,
            history: subscribedMode.history.slice(0, 20),
          })
        );
        return;
      }

      // PLACE BET
      if (msg.type === "bet") {
        if (!userId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
          return;
        }
        if (!subscribedMode) {
          ws.send(JSON.stringify({ type: "error", message: "Not subscribed to a mode" }));
          return;
        }
        if (subscribedMode.timeLeft <= 5) {
          ws.send(JSON.stringify({ type: "error", message: "Betting closed for this round" }));
          return;
        }
        if (!(await isGameEnabled("wingo"))) {
          ws.send(JSON.stringify({ type: "error", message: "This game is currently unavailable." }));
          return;
        }

        const { betType, value, amount } = msg;
        const validTypes = ["big", "small", "green", "red", "violet", "number"];
        if (!validTypes.includes(betType)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid bet type" }));
          return;
        }
        if (!amount || amount <= 0 || amount > 100000) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid bet amount" }));
          return;
        }
        if (betType === "number" && (value < 0 || value > 9)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid number" }));
          return;
        }

        // Deduct from wallet
        try {
          const newBalance = await walletService.placeBet({
            userId,
            amount,
            game: "wingo",
            roundId: subscribedMode.roundId,
          });

          // Record bet
          if (!subscribedMode.bets.has(userId)) {
            subscribedMode.bets.set(userId, []);
          }
          subscribedMode.bets.get(userId).push({
            type: betType,
            value: betType === "number" ? parseInt(value) : null,
            amount,
            roundId: subscribedMode.roundId,
          });

          ws.send(
            JSON.stringify({
              type: "bet_accepted",
              betType,
              value,
              amount,
              newBalance,
              period: subscribedMode.currentPeriod,
            })
          );
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message || "Bet failed" }));
        }
        return;
      }
    });

    ws.on("close", () => {
      if (subscribedMode) subscribedMode.clients.delete(ws);
    });
  });

  console.log("WinGo WebSocket server ready at /ws/wingo");
  return wss;
}
