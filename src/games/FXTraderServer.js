import { WebSocketServer } from "ws";
import { pool } from "../db/pool.js";
import { verifyAccessToken } from "../services/jwtService.js";
import { isBanned } from "../services/banCheck.js";
import { isGameEnabled } from "../services/gameSettings.js";
import * as walletService from "../services/walletService.js";
import { v4 as uuidv4 } from "uuid";

// Server-authoritative FX Trader — same migration WinGo/K3 already went
// through. The server is now the ONLY thing that generates price, runs the
// round clock, and decides outcomes; every connected browser just renders
// whatever this sends. This fixes the two gaps flagged earlier:
//  - "Force Next Round" is a real single round now, not a race between
//    independent per-browser rounds.
//  - "Minority Wins" sees every connected player's real stake for the
//    market, not just whichever browser happened to resolve first.

const CANDLE_DURATION = 30;
const ENTRY_WINDOW = 10;
const MINORITY_RANDOM_ESCAPE = 0.015;
const DEFAULT_HOUSE_EDGE = 3;
const DEFAULT_STAKE_THRESHOLD = 5000;
const DEFAULT_MAX_LIABILITY = 5000;
const AUTO_RISK_MINORITY_CHANCE = 0.7; // light book: 70% Minority, 30% price/random+edge

// A winning trade gets its stake back PLUS this much profit on top (92%),
// same shape as WinGo's PAYOUTS table (multiplier includes stake return).
// A losing trade forfeits the stake, which was already deducted at bet
// time — nothing further happens to it at resolution.
//
// Note: the original client-only prototype computed pnl as
// `won ? amt*0.92 : -amt` AFTER already deducting amt at bet time — that
// double-charges the loss (deducted once at bet, again at "loss") and never
// returns principal on a win (net -0.08*amt even when winning). Assuming
// that was a bug rather than an intentional house edge, this server uses
// the standard binary-options convention instead: win credits amount *
// 1.92 total, loss credits nothing further.
const PAYOUT_RATE = 0.92;

const MARKETS = [
  { id: "fx_usdjpy", label: "USD/JPY", base: 154.5,   vol: 0.00035, decimals: 2 },
  { id: "fx_eurusd", label: "EUR/USD", base: 1.0845,  vol: 0.00018, decimals: 4 },
  { id: "fx_gbpusd", label: "GBP/USD", base: 1.2710,  vol: 0.00022, decimals: 4 },
  { id: "fx_xauusd", label: "XAU/USD", base: 2345.0,  vol: 0.00025, decimals: 1 },
  { id: "fx_btcusd", label: "BTC/USD", base: 43250.0, vol: 0.0013,  decimals: 2 },
];

async function getControl(marketId, key, fallback) {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM game_controls WHERE game_id = $1 AND key = $2",
      [marketId, key]
    );
    return rows[0] ? rows[0].value : fallback;
  } catch {
    return fallback;
  }
}

async function clearForce(marketId) {
  try {
    await pool.query(
      "DELETE FROM game_controls WHERE game_id = $1 AND key = 'pending_force'",
      [marketId]
    );
  } catch {
    // best-effort — worst case the next round reads a stale force and this
    // clears on the round after
  }
}

function seedCandles(base) {
  let p = base * (0.99 + Math.random() * 0.02);
  const candles = [];
  for (let i = 0; i < 80; i++) {
    const move = (Math.random() - 0.5) * 2 * p * 0.0006;
    const o = p, c = p + move;
    const hi = Math.max(o, c) + Math.abs(move) * Math.random() * 0.4;
    const lo = Math.min(o, c) - Math.abs(move) * Math.random() * 0.4;
    candles.push({ o, c, hi, lo, closed: true });
    p = c;
  }
  return { candles, price: p };
}

class FXMarket {
  constructor(cfg, wss) {
    this.cfg = cfg;
    this.wss = wss;
    const seeded = seedCandles(cfg.base);
    this.candles = seeded.candles;
    this.price = seeded.price;
    this.candles.push({ o: this.price, c: this.price, hi: this.price, lo: this.price, closed: false });
    this.openRef = this.price;
    this.timeLeft = CANDLE_DURATION;
    this.roundId = uuidv4();
    this.period = this.generatePeriod();
    this.bets = new Map(); // userId -> [{ dir, amount, entryPrice }]
    this.stakeUp = 0;
    this.stakeDown = 0;
  }

  generatePeriod() {
    const now = new Date();
    return (
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}` +
      `${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}` +
      `${String(Math.floor(Date.now() / (CANDLE_DURATION * 1000))).slice(-6)}`
    );
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  snapshot() {
    return {
      marketId: this.cfg.id,
      label: this.cfg.label,
      decimals: this.cfg.decimals,
      candles: this.candles,
      live: this.price,
      openRef: this.openRef,
      timeLeft: this.timeLeft,
      period: this.period,
      entryOpen: this.timeLeft > CANDLE_DURATION - ENTRY_WINDOW,
    };
  }

  tickPrice() {
    const rev = ((this.cfg.base - this.price) / this.cfg.base) * 0.0002;
    const move = (Math.random() - 0.488 + rev) * this.price * this.cfg.vol * 0.18;
    this.price = Math.max(this.price + move, this.cfg.base * 0.5);
    const live = this.candles[this.candles.length - 1];
    if (live) {
      live.c = this.price;
      live.hi = Math.max(live.hi, this.price);
      live.lo = Math.min(live.lo, this.price);
    }
    this.broadcast({ type: "price", marketId: this.cfg.id, price: this.price });
  }

  async tickTimer() {
    this.timeLeft--;
    this.broadcast({
      type: "tick",
      marketId: this.cfg.id,
      timeLeft: this.timeLeft,
      entryOpen: this.timeLeft > CANDLE_DURATION - ENTRY_WINDOW,
    });
    if (this.timeLeft <= 0) await this.endRound();
  }

  /** Payout if UP (or DOWN) wins — stake × (1 + PAYOUT_RATE). */
  exposureIf(dirUp) {
    const stake = dirUp ? this.stakeUp : this.stakeDown;
    return stake * (1 + PAYOUT_RATE);
  }

  minorityOutcome(priceOutcomeUp, soloWinRate) {
    const up = this.stakeUp;
    const down = this.stakeDown;
    const bothActive = up > 0 && down > 0;
    if (!bothActive) {
      if (up === 0 && down === 0) return priceOutcomeUp;
      const soloIsUp = up > 0;
      const soloWins = Math.random() < soloWinRate;
      return soloWins ? soloIsUp : !soloIsUp;
    }
    if (Math.random() < MINORITY_RANDOM_ESCAPE) return priceOutcomeUp;
    if (up < down) return true;
    if (down < up) return false;
    return priceOutcomeUp;
  }

  /** If one side's payout would exceed maxLiability, force the cheaper side. */
  liabilityCapOutcome(maxLiability) {
    const payUp = this.exposureIf(true);
    const payDown = this.exposureIf(false);
    if (payUp <= 0 && payDown <= 0) return null;
    const upOver = payUp >= maxLiability;
    const downOver = payDown >= maxLiability;
    if (upOver && !downOver) return false; // force DOWN
    if (downOver && !upOver) return true; // force UP
    if (upOver && downOver) return payUp <= payDown; // cheaper side
    return null;
  }

  /** With houseEdge% chance, majority stake loses. */
  randomWithHouseEdge(priceOutcomeUp, houseEdgePercent) {
    const up = this.stakeUp;
    const down = this.stakeDown;
    if (houseEdgePercent > 0 && (up > 0 || down > 0) && Math.random() < houseEdgePercent / 100) {
      if (up === 0) return true;
      if (down === 0) return false;
      return up < down; // lighter side wins = majority loses
    }
    return priceOutcomeUp;
  }

  async endRound() {
    const closePrice = this.price;
    const openPrice = this.openRef;
    const priceOutcomeUp = closePrice >= openPrice;

    const mode = await getControl(this.cfg.id, "mode", "Auto Risk");
    const pendingForce = await getControl(this.cfg.id, "pending_force", "Random");
    const soloWinRateRaw = await getControl(this.cfg.id, "solo_win_rate", "");
    const soloWinRate =
      soloWinRateRaw !== "" && Number.isFinite(Number(soloWinRateRaw))
        ? Math.max(0, Math.min(1, Number(soloWinRateRaw)))
        : 0.5;
    const edgeRaw = await getControl(this.cfg.id, "house_edge", "");
    const houseEdge =
      edgeRaw !== "" && Number.isFinite(Number(edgeRaw))
        ? Math.max(0, Math.min(20, Number(edgeRaw)))
        : DEFAULT_HOUSE_EDGE;
    const threshRaw = await getControl(this.cfg.id, "stake_threshold", "");
    const stakeThreshold =
      threshRaw !== "" && Number.isFinite(Number(threshRaw)) && Number(threshRaw) > 0
        ? Number(threshRaw)
        : DEFAULT_STAKE_THRESHOLD;
    const liabRaw = await getControl(this.cfg.id, "max_liability", "");
    const maxLiability =
      liabRaw !== "" && Number.isFinite(Number(liabRaw)) && Number(liabRaw) > 0
        ? Number(liabRaw)
        : DEFAULT_MAX_LIABILITY;

    let outcomeUp = priceOutcomeUp;
    let resolvedMode = mode; // audit: what path actually decided the round

    if (mode === "Manual" && (pendingForce === "UP" || pendingForce === "DOWN")) {
      outcomeUp = pendingForce === "UP";
      resolvedMode = "Manual";
      await clearForce(this.cfg.id);
    } else if (mode === "Manual") {
      // No force queued — behave like Random + edge
      outcomeUp = this.randomWithHouseEdge(priceOutcomeUp, houseEdge);
      resolvedMode = "Random";
    } else if (mode === "Minority Wins") {
      outcomeUp = this.minorityOutcome(priceOutcomeUp, soloWinRate);
      resolvedMode = "Minority Wins";
    } else if (mode === "Liability Cap") {
      const capped = this.liabilityCapOutcome(maxLiability);
      if (capped != null) {
        outcomeUp = capped;
        resolvedMode = "Liability Cap";
      } else {
        outcomeUp = this.randomWithHouseEdge(priceOutcomeUp, houseEdge);
        resolvedMode = "Random";
      }
    } else if (mode === "Auto Risk") {
      const total = this.stakeUp + this.stakeDown;
      if (total >= stakeThreshold) {
        const capped = this.liabilityCapOutcome(maxLiability);
        if (capped != null) {
          outcomeUp = capped;
          resolvedMode = "Auto Risk→Cap";
        } else {
          outcomeUp = this.minorityOutcome(priceOutcomeUp, soloWinRate);
          resolvedMode = "Auto Risk→Minority";
        }
      } else if (Math.random() < AUTO_RISK_MINORITY_CHANCE) {
        outcomeUp = this.minorityOutcome(priceOutcomeUp, soloWinRate);
        resolvedMode = "Auto Risk→Minority";
      } else {
        outcomeUp = this.randomWithHouseEdge(priceOutcomeUp, houseEdge);
        resolvedMode = "Auto Risk→Random";
      }
    } else {
      outcomeUp = this.randomWithHouseEdge(priceOutcomeUp, houseEdge);
      resolvedMode = "Random";
    }

    try {
      await pool.query(
        `INSERT INTO game_rounds (id, game, period, result, result_data, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          this.roundId,
          this.cfg.id,
          this.period,
          outcomeUp ? "UP" : "DOWN",
          JSON.stringify({
            open: openPrice,
            close: closePrice,
            priceOutcomeUp,
            mode,
            resolvedMode,
            stakeUp: this.stakeUp,
            stakeDown: this.stakeDown,
            maxLiability,
          }),
        ]
      );
    } catch (err) {
      console.error("Failed to save FX round:", err.message);
    }

    const settled = []; // [{ userId, positions: [{dir, amount, won, credited}] }]
    for (const [userId, positions] of this.bets.entries()) {
      let totalCredit = 0;
      const posResults = [];
      for (const pos of positions) {
        const won = (pos.dir === "UP") === outcomeUp;
        const credited = won ? pos.amount * (1 + PAYOUT_RATE) : 0;
        totalCredit += credited;
        posResults.push({ dir: pos.dir, amount: pos.amount, entryPrice: pos.entryPrice, won, credited });
      }
      if (totalCredit > 0) {
        try {
          await walletService.creditWin({
            userId,
            amount: totalCredit,
            game: this.cfg.id,
            roundId: this.roundId,
          });
        } catch (err) {
          console.error("Failed to credit FX win:", err.message);
        }
      }
      settled.push({ userId, positions: posResults });
    }

    if (this.candles.length) this.candles[this.candles.length - 1].closed = true;

    this.broadcast({
      type: "result",
      marketId: this.cfg.id,
      period: this.period,
      roundId: this.roundId,
      outcome: outcomeUp ? "UP" : "DOWN",
      open: openPrice,
      close: closePrice,
      resolvedMode,
      settled, // each client filters this down to its own userId
    });

    // Next round
    this.bets.clear();
    this.stakeUp = 0;
    this.stakeDown = 0;
    this.openRef = closePrice;
    this.timeLeft = CANDLE_DURATION;
    this.period = this.generatePeriod();
    this.roundId = uuidv4();
    this.candles.push({ o: closePrice, c: closePrice, hi: closePrice, lo: closePrice, closed: false });
    if (this.candles.length > 120) this.candles.shift();

    this.broadcast({
      type: "new_round",
      marketId: this.cfg.id,
      period: this.period,
      timeLeft: this.timeLeft,
      openRef: this.openRef,
    });
  }
}

export function createFxTraderServer() {
  const wss = new WebSocketServer({ noServer: true });

  const markets = {};
  for (const cfg of MARKETS) markets[cfg.id] = new FXMarket(cfg, wss);

  setInterval(() => {
    for (const m of Object.values(markets)) m.tickPrice();
  }, 280);

  setInterval(() => {
    for (const m of Object.values(markets)) m.tickTimer();
  }, 1000);

  wss.on("connection", (ws) => {
    let userId = null;

    ws.on("message", async (rawMsg) => {
      let msg;
      try { msg = JSON.parse(rawMsg); } catch { return; }

      if (msg.type === "auth") {
        try {
          const payload = verifyAccessToken(msg.token);
          if (await isBanned(payload.sub)) {
            ws.send(JSON.stringify({ type: "error", message: "This account has been suspended." }));
            ws.close();
            return;
          }
          userId = payload.sub;
          ws.send(JSON.stringify({
            type: "auth_ok",
            userId,
            markets: Object.values(markets).map((m) => m.snapshot()),
          }));
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
          ws.close();
        }
        return;
      }

      if (msg.type === "bet") {
        if (!userId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
          return;
        }
        const market = markets[msg.marketId];
        if (!market) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid market" }));
          return;
        }
        if (!market.timeLeft || market.timeLeft <= CANDLE_DURATION - ENTRY_WINDOW) {
          ws.send(JSON.stringify({ type: "error", message: "Entry closed for this round" }));
          return;
        }
        if (!(await isGameEnabled("fxtrader"))) {
          ws.send(JSON.stringify({ type: "error", message: "This game is currently unavailable." }));
          return;
        }
        const dir = msg.dir === "UP" ? "UP" : msg.dir === "DOWN" ? "DOWN" : null;
        const amount = Number(msg.amount);
        if (!dir) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid direction" }));
          return;
        }
        if (!amount || amount <= 0 || amount > 100000) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid amount" }));
          return;
        }

        try {
          const newBalance = await walletService.placeBet({
            userId,
            amount,
            game: market.cfg.id,
            roundId: market.roundId,
          });

          if (!market.bets.has(userId)) market.bets.set(userId, []);
          market.bets.get(userId).push({ dir, amount, entryPrice: market.price });
          if (dir === "UP") market.stakeUp += amount; else market.stakeDown += amount;

          ws.send(JSON.stringify({
            type: "bet_accepted",
            marketId: market.cfg.id,
            dir,
            amount,
            entryPrice: market.price,
            newBalance,
            period: market.period,
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message || "Bet failed" }));
        }
        return;
      }
    });
  });

  console.log("FX Trader WebSocket server ready at /ws/fxtrader");
  return wss;
}
