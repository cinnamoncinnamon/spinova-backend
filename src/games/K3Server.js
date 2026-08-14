import { WebSocketServer } from "ws";
import { pool } from "../db/pool.js";
import { verifyAccessToken } from "../services/jwtService.js";
import { isBanned } from "../services/banCheck.js";
import { isGameEnabled } from "../services/gameSettings.js";
import * as walletService from "../services/walletService.js";
import { v4 as uuidv4 } from "uuid";

const MODES = [
  { id: "15s", seconds: 15 },
  { id: "30s", seconds: 30 },
  { id: "1m", seconds: 60 },
  { id: "3m", seconds: 180 },
];

const TOTAL_PAYOUTS = {
  3: 207.36, 4: 69.12, 5: 34.56, 6: 20.74, 7: 13.83, 8: 9.88, 9: 8.3,
  10: 7.68, 11: 7.68, 12: 8.3, 13: 9.88, 14: 13.83, 15: 20.74, 16: 34.56,
  17: 69.12, 18: 207.36,
};

const MINORITY_RANDOM_ESCAPE = 0.015;

// ── Admin control helpers ──────────────────────────────────────────────────

async function getControl(gameId, key, fallback) {
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
       WHERE game_id = $1 AND key IN ('force_result', 'force_total')`,
      [gameId]
    );
  } catch {
    // best-effort
  }
}

function rollDice() {
  return [
    Math.ceil(Math.random() * 6),
    Math.ceil(Math.random() * 6),
    Math.ceil(Math.random() * 6),
  ];
}

/**
 * Sum stakes that lean Big vs Small for the current round.
 * - bigsmall group bets count fully
 * - total (sum) bets map 3-10 → Small, 11-18 → Big
 * - odd/even and combo bets are ignored for the axis decision
 */
function sumBigSmallStakes(betsMap) {
  let stakeBig = 0;
  let stakeSmall = 0;

  for (const userBets of betsMap.values()) {
    for (const bet of userBets) {
      const amt = Number(bet.amount) || 0;
      if (bet.betGroup === "bigsmall") {
        if (bet.betValue === "Big") stakeBig += amt;
        else if (bet.betValue === "Small") stakeSmall += amt;
      } else if (bet.betGroup === "total") {
        const total = Number(bet.betValue);
        if (total >= 11) stakeBig += amt;
        else if (total >= 3) stakeSmall += amt;
      }
    }
  }
  return { stakeBig, stakeSmall };
}

/**
 * Roll dice until the sum is on the requested side (or matches an optional
 * forced total / force_result). Caps attempts so we never hang.
 */
function rollForSide(wantBig, forceTotal = null, forceResult = null) {
  for (let i = 0; i < 80; i++) {
    const dice = rollDice();
    const sum = dice[0] + dice[1] + dice[2];
    const big = sum >= 11;
    const odd = sum % 2 !== 0;
    const isTriple = dice[0] === dice[1] && dice[1] === dice[2];

    if (forceTotal != null && sum === forceTotal) {
      return { dice, sum, big: big ? "Big" : "Small", oddEven: odd ? "Odd" : "Even", isTriple };
    }
    if (forceResult === "Big" && big) {
      return { dice, sum, big: "Big", oddEven: odd ? "Odd" : "Even", isTriple };
    }
    if (forceResult === "Small" && !big) {
      return { dice, sum, big: "Small", oddEven: odd ? "Odd" : "Even", isTriple };
    }
    if (forceResult === "Odd" && odd) {
      return { dice, sum, big: big ? "Big" : "Small", oddEven: "Odd", isTriple };
    }
    if (forceResult === "Even" && !odd) {
      return { dice, sum, big: big ? "Big" : "Small", oddEven: "Even", isTriple };
    }

    // side-only constraint (no force)
    if (forceTotal == null && forceResult == null && big === wantBig) {
      return { dice, sum, big: big ? "Big" : "Small", oddEven: odd ? "Odd" : "Even", isTriple };
    }
  }
  // ultimate fallback
  const dice = rollDice();
  const sum = dice[0] + dice[1] + dice[2];
  return {
    dice,
    sum,
    big: sum >= 11 ? "Big" : "Small",
    oddEven: sum % 2 === 0 ? "Even" : "Odd",
    isTriple: dice[0] === dice[1] && dice[1] === dice[2],
  };
}


const DEFAULT_HOUSE_EDGE = 3;
const DEFAULT_STAKE_THRESHOLD = 5000;
const DEFAULT_MAX_LIABILITY = 5000;
const AUTO_RISK_MINORITY_CHANCE = 0.7;

function randomDiceResult() {
  const dice = rollDice();
  const sum = dice[0] + dice[1] + dice[2];
  return {
    dice,
    sum,
    big: sum >= 11 ? "Big" : "Small",
    oddEven: sum % 2 === 0 ? "Even" : "Odd",
    isTriple: dice[0] === dice[1] && dice[1] === dice[2],
  };
}

function readNumericControl(raw, fallback, min, max) {
  if (raw === "" || raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Estimate payout if Big or Small wins (bigsmall @2x, totals on that side @ their mult). */
function estimateSidePayout(betsMap, wantBig) {
  let total = 0;
  for (const userBets of betsMap.values()) {
    for (const bet of userBets) {
      const amt = Number(bet.amount) || 0;
      if (bet.betGroup === "bigsmall") {
        if (wantBig && bet.betValue === "Big") total += amt * 2;
        if (!wantBig && bet.betValue === "Small") total += amt * 2;
      } else if (bet.betGroup === "total") {
        const t = Number(bet.betValue);
        const isBig = t >= 11;
        if (isBig === wantBig && TOTAL_PAYOUTS[t]) total += amt * TOTAL_PAYOUTS[t];
      }
    }
  }
  return total;
}

function minorityResult(betsMap, soloWinRate) {
  const { stakeBig, stakeSmall } = sumBigSmallStakes(betsMap);
  const bothActive = stakeBig > 0 && stakeSmall > 0;

  if (Math.random() < MINORITY_RANDOM_ESCAPE) return randomDiceResult();
  if (!bothActive) {
    if (stakeBig === 0 && stakeSmall === 0) return randomDiceResult();
    const soloIsBig = stakeBig > 0;
    const soloWins = Math.random() < soloWinRate;
    return rollForSide(soloWins ? soloIsBig : !soloIsBig);
  }
  let wantBig;
  if (stakeBig < stakeSmall) wantBig = true;
  else if (stakeSmall < stakeBig) wantBig = false;
  else wantBig = Math.random() < 0.5;
  return rollForSide(wantBig);
}

function liabilityCapResult(betsMap, maxLiability) {
  const payBig = estimateSidePayout(betsMap, true);
  const paySmall = estimateSidePayout(betsMap, false);
  if (payBig <= 0 && paySmall <= 0) return null;
  const bigOver = payBig >= maxLiability;
  const smallOver = paySmall >= maxLiability;
  if (bigOver && !smallOver) return rollForSide(false);
  if (smallOver && !bigOver) return rollForSide(true);
  if (bigOver && smallOver) return rollForSide(payBig <= paySmall);
  return null;
}

function randomWithHouseEdge(betsMap, houseEdgePercent) {
  const { stakeBig, stakeSmall } = sumBigSmallStakes(betsMap);
  if (houseEdgePercent > 0 && (stakeBig > 0 || stakeSmall > 0) && Math.random() < houseEdgePercent / 100) {
    if (stakeBig === 0) return rollForSide(true);
    if (stakeSmall === 0) return rollForSide(false);
    return rollForSide(stakeBig < stakeSmall);
  }
  return randomDiceResult();
}

async function generateResult(modeId, betsMap) {
  const gameId = `k3_${modeId}`;
  const mode = await getControl(gameId, "mode", "Auto Risk");
  const forceResult = await getControl(gameId, "force_result", "Random");
  const forceTotal = await getControl(gameId, "force_total", "Random");
  const soloWinRate = readNumericControl(await getControl(gameId, "solo_win_rate", ""), 0.5, 0, 1);
  const houseEdge = readNumericControl(await getControl(gameId, "house_edge", ""), DEFAULT_HOUSE_EDGE, 0, 20);
  const stakeThreshold = readNumericControl(await getControl(gameId, "stake_threshold", ""), DEFAULT_STAKE_THRESHOLD, 1, 1e9);
  const maxLiability = readNumericControl(await getControl(gameId, "max_liability", ""), DEFAULT_MAX_LIABILITY, 1, 1e9);

  if (mode === "Manual") {
    if (forceTotal !== "Random") {
      const target = parseInt(forceTotal, 10);
      const result = rollForSide(null, target, null);
      await clearForceKeys(gameId);
      return result;
    }
    if (forceResult !== "Random") {
      const result = rollForSide(null, null, forceResult);
      await clearForceKeys(gameId);
      return result;
    }
    return randomDiceResult();
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

  // Random + legacy force keys
  if (forceTotal !== "Random") {
    return rollForSide(null, parseInt(forceTotal, 10), null);
  }
  if (forceResult !== "Random") {
    return rollForSide(null, null, forceResult);
  }
  return randomWithHouseEdge(betsMap, houseEdge);
}

function calculateWin(bet, result) {

  const { dice, sum, big, oddEven, isTriple } = result;
  let payout = 0;
  if (bet.betGroup === "total" && bet.betValue === sum) payout = TOTAL_PAYOUTS[sum] || 0;
  else if (bet.betGroup === "bigsmall" && bet.betValue === big && !isTriple) payout = 2;
  else if (bet.betGroup === "oddeven" && bet.betValue === oddEven && !isTriple) payout = 2;
  else if (bet.betGroup === "twoSame") {
    const pair = bet.betValue;
    const s = [...dice].sort();
    if (s[0] === pair[0] && s[1] === pair[1]) payout = 17.64;
  } else if (bet.betGroup === "threeSame") {
    if (bet.betValue === "any3" && isTriple) payout = 29.4;
    else if (isTriple && dice[0] === bet.betValue) payout = 176.4;
  } else if (bet.betGroup === "diffCombo") {
    const cn = bet.betValue.split(",").map(Number).sort();
    if (JSON.stringify(cn) === JSON.stringify([...dice].sort((a, b) => a - b)) && !isTriple)
      payout = 17.64;
  }
  return bet.amount * payout;
}

class K3Mode {
  constructor(config) {
    this.id = config.id;
    this.seconds = config.seconds;
    this.timeLeft = config.seconds;
    this.currentPeriod = this.generatePeriod();
    this.bets = new Map();
    this.history = [];
    this.roundId = uuidv4();
    this.clients = new Set();
  }

  generatePeriod() {
    const n = new Date();
    return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, "0")}${String(n.getDate()).padStart(2, "0")}K3${this.id.toUpperCase()}${String(Math.floor(Date.now() / (this.seconds * 1000))).slice(-6)}`;
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const c of this.clients) if (c.readyState === 1) c.send(msg);
  }

  tick() {
    this.timeLeft--;
    this.broadcast({ type: "tick", timeLeft: this.timeLeft, period: this.currentPeriod });
    if (this.timeLeft <= 0) this.endRound();
  }

  async endRound() {
    const result = await generateResult(this.id, this.bets);
    try {
      await pool.query(
        `INSERT INTO game_rounds (id,game,period,result,result_data,created_at) VALUES ($1,$2,$3,$4,$5,NOW())`,
        [this.roundId, "k3", this.currentPeriod, result.sum.toString(), JSON.stringify(result)]
      );
    } catch (e) {
      console.error("K3 save error:", e.message);
    }

    for (const [userId, userBets] of this.bets.entries()) {
      const totalWin = userBets.reduce((s, b) => s + calculateWin(b, result), 0);
      if (totalWin > 0) {
        try {
          await walletService.creditWin({
            userId,
            amount: totalWin,
            game: "k3",
            roundId: this.roundId,
          });
        } catch (e) {
          console.error("K3 credit error:", e.message);
        }
      }
    }

    this.broadcast({ type: "result", period: this.currentPeriod, result, roundId: this.roundId });
    this.history.unshift({ period: this.currentPeriod, ...result });
    if (this.history.length > 50) this.history.pop();

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

export function createK3Server() {
  const wss = new WebSocketServer({ noServer: true });
  const modes = {};
  for (const config of MODES) modes[config.id] = new K3Mode(config);
  setInterval(() => {
    for (const m of Object.values(modes)) m.tick();
  }, 1000);

  wss.on("connection", (ws) => {
    let userId = null,
      subscribedMode = null;
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === "auth") {
        try {
          const p = verifyAccessToken(msg.token);
          if (await isBanned(p.sub)) {
            ws.send(JSON.stringify({ type: "error", message: "This account has been suspended." }));
            ws.close();
            return;
          }
          userId = p.sub;
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
          ws.close();
        }
        return;
      }
      if (msg.type === "subscribe") {
        const mode = modes[msg.modeId];
        if (!mode) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid mode" }));
          return;
        }
        if (subscribedMode) subscribedMode.clients.delete(ws);
        subscribedMode = mode;
        subscribedMode.clients.add(ws);
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
      if (msg.type === "bet") {
        if (!userId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
          return;
        }
        if (!subscribedMode) {
          ws.send(JSON.stringify({ type: "error", message: "Not subscribed" }));
          return;
        }
        if (subscribedMode.timeLeft <= 5) {
          ws.send(JSON.stringify({ type: "error", message: "Betting closed" }));
          return;
        }
        if (!(await isGameEnabled("k3"))) {
          ws.send(JSON.stringify({ type: "error", message: "This game is currently unavailable." }));
          return;
        }
        const { betGroup, betValue, amount } = msg;
        if (!betGroup || betValue === undefined || !amount || amount <= 0) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid bet" }));
          return;
        }
        try {
          const newBalance = await walletService.placeBet({
            userId,
            amount,
            game: "k3",
            roundId: subscribedMode.roundId,
          });
          if (!subscribedMode.bets.has(userId)) subscribedMode.bets.set(userId, []);
          subscribedMode.bets.get(userId).push({ betGroup, betValue, amount });
          ws.send(JSON.stringify({ type: "bet_accepted", betGroup, betValue, amount, newBalance }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: e.message }));
        }
      }
    });
    ws.on("close", () => {
      if (subscribedMode) subscribedMode.clients.delete(ws);
    });
  });
  console.log("K3 WebSocket server ready at /ws/k3");
  return wss;
}
