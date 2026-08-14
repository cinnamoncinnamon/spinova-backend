import { WebSocketServer } from "ws";
import crypto from "crypto";
import { pool } from "../db/pool.js";
import { verifyAccessToken } from "../services/jwtService.js";
import { isBanned } from "../services/banCheck.js";
import { isGameEnabled } from "../services/gameSettings.js";
import * as walletService from "../services/walletService.js";
import { v4 as uuidv4 } from "uuid";

// One shared engine, skinned three ways (Aviator / Moto Ride / Road Rush) —
// per the roadmap, these differ only in visual presentation on the frontend,
// not core mechanics. gameId is one of "aviator" | "motoride" | "roadrush".

const BETTING_PHASE_MS = 7000; // window during which bets are accepted
const CRASHED_PHASE_MS = 3500; // pause showing the crash result before next round
const TICK_MS = 100; // multiplier broadcast rate — needs to feel live, not once/sec like WinGo/K3
const GROWTH_RATE = 0.00011; // tuned so an unforced round typically runs ~6-12s before crashing
const BONUS_GROWTH_RATE = 0.0011; // ~10x faster — used only once every active bet is settled
const BONUS_BIG_CHANCE = 1 / 12; // roughly 1 in 12 bonus rounds land in the big range instead of the normal one
const BONUS_TRIGGER_CHANCE = 0.4; // chance a settled round becomes a bonus round AT ALL — decided once per round, not guaranteed every time everyone's cashed out (a guaranteed pattern would be exactly as recognizable/exploitable as a predictable low crash)
const BONUS_NORMAL_RANGE = [20, 80];
const BONUS_BIG_RANGE = [80, 500];

function randomInRange([lo, hi]) {
  return lo + Math.random() * (hi - lo);
}

// Random every time, not a fixed pool — normally lands 20x-80x; roughly
// 1-in-12 times it lands in the much bigger 80x-500x range instead. This is
// purely cosmetic (see triggerBonusRound below), so there's no reason for it
// to be cryptographically tied to the round's provably-fair seed.
function pickBonusTarget() {
  const isBig = Math.random() < BONUS_BIG_CHANCE;
  const raw = randomInRange(isBig ? BONUS_BIG_RANGE : BONUS_NORMAL_RANGE);
  return Math.round(raw * 100) / 100;
}
// Default house edge when admin hasn't set one — ~3% (classic Bustabit-style).
const DEFAULT_HOUSE_EDGE_PERCENT = 3;

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

// Multiplier as a function of elapsed ms — server always derives "current
// multiplier" from elapsed time rather than storing tick history, so a
// cashout can always be checked against the true value, never a client's
// claimed one.
function multiplierAtElapsed(elapsedMs, rate = GROWTH_RATE) {
  return Math.max(1, Math.exp(rate * elapsedMs));
}

// Elapsed ms at which a given multiplier is reached — inverse of the above,
// used to know when to fire the crash event.
function elapsedAtMultiplier(mult) {
  return Math.log(mult) / GROWTH_RATE;
}

/**
 * Provably-fair crash point with a real house edge.
 *
 * How the edge works (industry-standard Bustabit formula):
 *   1. Hash the server seed → 52-bit integer.
 *   2. With probability ≈ houseEdgePercent/100, force an instant 1.00x crash
 *      (player loses if they didn't cash out — which they can't at 1.00x).
 *      e.g. 3% edge → ~1 in 33 rounds; 5% → ~1 in 20; 1% → ~1 in 100.
 *   3. Otherwise derive a fair crash multiplier from the same hash.
 *
 * Expected RTP ≈ 100% − houseEdgePercent when players cash out optimally
 * in the long run. Instant 1.00x is the edge; the rest of the distribution
 * is fair.
 *
 * houseEdgePercent: 0–20 (0 = no edge / pure fair, 3 = default, 10 = aggressive)
 */
function provablyFairCrashPoint(serverSeed, houseEdgePercent = DEFAULT_HOUSE_EDGE_PERCENT) {
  const hash = crypto.createHash("sha256").update(serverSeed).digest("hex");
  const int52 = parseInt(hash.slice(0, 13), 16); // first 52 bits of entropy

  const edge = Math.max(0, Math.min(20, Number(houseEdgePercent) || 0));
  if (edge > 0) {
    // edge 3 → mod 33; edge 5 → mod 20; edge 1 → mod 100
    const mod = Math.max(2, Math.round(100 / edge));
    if (int52 % mod === 0) return 1.0;
  }

  const e = Math.pow(2, 52);
  const point = Math.floor((100 * e - int52) / (e - int52)) / 100;
  return Math.max(1.0, point);
}

async function generateCrashPoint(gameId) {
  const serverSeed = crypto.randomBytes(32).toString("hex");
  const seedHash = crypto.createHash("sha256").update(serverSeed).digest("hex");

  // Default Auto Risk = Cap-heavy random blocks (Soft shorter, Cap longer)
  const mode = await getGameControl(gameId, "mode", "Auto Risk");
  let minMult = parseFloat(await getGameControl(gameId, "min_multiplier", "1.01"));
  let maxMult = parseFloat(await getGameControl(gameId, "max_multiplier", "10"));
  if (!Number.isFinite(minMult) || minMult < 1) minMult = 1.01;
  if (!Number.isFinite(maxMult) || maxMult <= minMult) maxMult = Math.max(10, minMult + 1);

  const edgeRaw = await getGameControl(gameId, "house_edge", "");
  const houseEdge =
    edgeRaw !== "" && Number.isFinite(Number(edgeRaw))
      ? Math.max(0, Math.min(20, Number(edgeRaw)))
      : DEFAULT_HOUSE_EDGE_PERCENT;

  const threshRaw = await getGameControl(gameId, "stake_threshold", "");
  const stakeThreshold =
    threshRaw !== "" && Number.isFinite(Number(threshRaw)) && Number(threshRaw) > 0
      ? Number(threshRaw)
      : 5000;

  const liabRaw = await getGameControl(gameId, "max_liability", "");
  const maxLiability =
    liabRaw !== "" && Number.isFinite(Number(liabRaw)) && Number(liabRaw) > 0
      ? Number(liabRaw)
      : 5000;

  // Max rounds a single sub-mode can stay (Soft or Cap). Min is always 1.
  const switchRaw = await getGameControl(gameId, "auto_switch_rounds", "");
  const autoSwitchMax =
    switchRaw !== "" && Number.isFinite(Number(switchRaw)) && Number(switchRaw) >= 1
      ? Math.min(20, Math.floor(Number(switchRaw)))
      : 5;

  let crashPoint;
  const fastGrowth = mode === "Force High";
  if (mode === "Force Crash") {
    crashPoint = parseFloat(await getGameControl(gameId, "force_multiplier", "1.5"));
  } else if (mode === "Force High") {
    const lo = Math.max(5, minMult);
    crashPoint = lo + Math.random() * Math.max(0.01, maxMult - lo);
  } else {
    // Random / Soft Bias / Liability Cap / Auto Risk — fair point (+ house edge)
    crashPoint = Math.min(Math.max(provablyFairCrashPoint(serverSeed, houseEdge), minMult), maxMult);
  }

  if (!Number.isFinite(crashPoint) || crashPoint < 1) crashPoint = 1.5;

  return {
    crashPoint: Math.round(crashPoint * 100) / 100,
    serverSeed,
    seedHash,
    fastGrowth,
    houseEdge,
    mode,
    stakeThreshold,
    maxLiability,
    autoSwitchMax,
  };
}

/** Soft Bias: heavy book → pull crash toward 1.x; light book → keep fair point. */
function applySoftBias(baseCrash, totalStake, threshold) {
  if (!totalStake || totalStake <= 0 || !threshold || totalStake <= threshold) return baseCrash;
  const over = (totalStake - threshold) / threshold;
  const pull = Math.min(0.85, over * 0.7);
  const adjusted = 1 + (baseCrash - 1) * (1 - pull);
  return Math.max(1.1, Math.round(adjusted * 100) / 100);
}

class CrashRound {
  constructor(gameId) {
    this.gameId = gameId;
    this.clients = new Set();
    this.history = [];
    // Auto Risk state: Cap stays longer / more often than Soft
    this.autoSubMode = "Liability Cap"; // start Cap-heavy
    this.autoRoundsLeft = 0; // 0 → pick a new block on next startNewRound
    this.startNewRound();
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  async startNewRound() {
    this.phase = "betting";
    this.roundId = uuidv4();
    this.bets = new Map();
    this.bettingEndsAt = Date.now() + BETTING_PHASE_MS;

    const gen = await generateCrashPoint(this.gameId);
    this.crashPoint = gen.crashPoint;
    this.originalCrashPoint = gen.crashPoint;
    this.serverSeed = gen.serverSeed;
    this.seedHash = gen.seedHash;
    this.fastGrowth = gen.fastGrowth;
    this.stakeThreshold = gen.stakeThreshold;
    this.maxLiability = gen.maxLiability;
    this.houseEdge = gen.houseEdge;
    this.autoSwitchMax = gen.autoSwitchMax || 5;

    // Auto Risk: random-length blocks, Cap more / Soft less
    // Soft blocks: 1 .. ceil(max/2)   e.g. max=5 → Soft stays 1–3
    // Cap  blocks: ceil(max/2) .. max e.g. max=5 → Cap stays 3–5
    if (gen.mode === "Auto Risk") {
      if (this.autoRoundsLeft <= 0) {
        const max = this.autoSwitchMax;
        const softMax = Math.max(1, Math.ceil(max / 2)); // Soft shorter
        const capMin = Math.max(1, Math.ceil(max / 2)); // Cap longer
        if (this.autoSubMode === "Soft Bias") {
          // just finished Soft (or first time) → switch to Cap for longer
          this.autoSubMode = "Liability Cap";
          this.autoRoundsLeft = capMin + Math.floor(Math.random() * (max - capMin + 1));
        } else {
          // finished Cap → short Soft stretch
          this.autoSubMode = "Soft Bias";
          this.autoRoundsLeft = 1 + Math.floor(Math.random() * softMax);
        }
      }
      this.riskMode = this.autoSubMode;
      this.autoRoundsLeft -= 1;
    } else {
      this.riskMode = gen.mode;
    }

    this.runStartedAt = null;
    this.extended = false;
    this.bonusRolled = false;
    this.bonusStartedAt = null;
    this.bonusStartMultiplier = null;

    this.broadcast({
      type: "betting_open",
      roundId: this.roundId,
      seedHash: this.seedHash,
      bettingMs: BETTING_PHASE_MS,
      bettingEndsAt: this.bettingEndsAt,
      history: this.history.slice(0, 30),
    });
  }

  openStake() {
    let total = 0;
    for (const userBets of this.bets.values()) {
      for (const bet of userBets.values()) {
        if (!bet.cashedOut) total += bet.amount;
      }
    }
    return total;
  }

  totalStake() {
    let total = 0;
    for (const userBets of this.bets.values()) {
      for (const bet of userBets.values()) total += bet.amount;
    }
    return total;
  }

  startRunning() {
    if (this.riskMode === "Soft Bias") {
      this.crashPoint = applySoftBias(
        this.originalCrashPoint,
        this.totalStake(),
        this.stakeThreshold
      );
    }
    this.phase = "running";
    this.runStartedAt = Date.now();
    this.broadcast({ type: "round_start", roundId: this.roundId });
  }

  // True once every bet placed this round (across every user and slot) has
  // been cashed out — or if nobody bet at all. Once true, no one has real
  // money left riding on this round, so it's safe to let the multiplier fly
  // past its original target purely for spectacle.
  allBetsSettled() {
    for (const userBets of this.bets.values()) {
      for (const bet of userBets.values()) {
        if (!bet.cashedOut) return false;
      }
    }
    return true;
  }

  // Called the moment allBetsSettled() first becomes true mid-round. Doesn't
  // touch the original provably-fair result at all (that's preserved as
  // originalCrashPoint for the record) — it just picks a new, higher, purely
  // cosmetic target and switches to a faster growth rate so it arrives in a
  // few seconds instead of taking as long as a real round would. Nothing
  // about this affects any payout, since by definition no one has money
  // left in play.
  triggerBonusRound() {
    const startMult = this.currentMultiplier(); // must read this BEFORE flipping `extended`, or currentMultiplier() reads its own not-yet-set bonus fields
    this.extended = true;
    this.bonusStartedAt = Date.now();
    this.bonusStartMultiplier = startMult;

    let target = pickBonusTarget();
    if (target <= this.bonusStartMultiplier) target = this.bonusStartMultiplier * (5 + Math.random() * 10);
    this.crashPoint = Math.round(target * 100) / 100;

    this.broadcast({ type: "bonus_round", crashTarget: this.crashPoint });
  }

  currentMultiplier() {
    if (this.phase !== "running") return 1.0;
    if (!this.extended) {
      const rate = this.fastGrowth ? BONUS_GROWTH_RATE : GROWTH_RATE;
      return Math.min(multiplierAtElapsed(Date.now() - this.runStartedAt, rate), this.crashPoint);
    }
    const bonusElapsed = Date.now() - this.bonusStartedAt;
    return Math.min(this.bonusStartMultiplier * Math.exp(BONUS_GROWTH_RATE * bonusElapsed), this.crashPoint);
  }

  tick() {
    const now = Date.now();

    if (this.phase === "betting") {
      if (now >= this.bettingEndsAt) this.startRunning();
      return;
    }

    if (this.phase === "running") {
      if (!this.extended && !this.bonusRolled && this.allBetsSettled()) {
        this.bonusRolled = true;
        if (Math.random() < BONUS_TRIGGER_CHANCE) this.triggerBonusRound();
      }

      const mult = this.currentMultiplier();

      // Liability Cap (mode B): if unpaid exposure (open stake × mult) would
      // exceed the admin max, force crash now — regardless of the fair point.
      if (
        this.riskMode === "Liability Cap" &&
        !this.extended &&
        this.maxLiability > 0
      ) {
        const open = this.openStake();
        if (open > 0 && open * mult >= this.maxLiability) {
          this.crashPoint = Math.round(mult * 100) / 100;
          this.crash();
          return;
        }
      }

      if (mult >= this.crashPoint) {
        this.crash();
        return;
      }
      this.broadcast({ type: "tick", multiplier: Math.round(mult * 100) / 100 });
      return;
    }
    // "crashed" phase just waits out its timer via setTimeout in crash(), nothing to do here
  }

  async crash() {
    this.phase = "crashed";

    try {
      await pool.query(
        `INSERT INTO game_rounds (id, game, period, result, result_data, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          this.roundId,
          this.gameId,
          this.roundId,
          this.crashPoint.toString(),
          JSON.stringify({
            crashPoint: this.crashPoint,
            originalCrashPoint: this.originalCrashPoint,
            extended: this.extended,
            seedHash: this.seedHash,
            serverSeed: this.serverSeed,
          }),
        ]
      );
    } catch (err) {
      console.error(`[${this.gameId}] Failed to save round:`, err.message);
    }

    this.broadcast({
      type: "crashed",
      roundId: this.roundId,
      crashPoint: this.crashPoint,
      extended: this.extended,
      serverSeed: this.serverSeed, // reveal — anyone can now verify sha256(serverSeed) === seedHash and re-derive originalCrashPoint
    });

    this.history.unshift({ roundId: this.roundId, crashPoint: this.crashPoint, extended: this.extended });
    if (this.history.length > 30) this.history.pop();

    setTimeout(() => this.startNewRound(), CRASHED_PHASE_MS);
  }

  async placeBet(userId, slot, amount, ws) {
    if (this.phase !== "betting") throw new Error("Betting is closed for this round");
    if (!(await isGameEnabled(this.gameId))) throw new Error("This game is currently unavailable.");
    if (!this.bets.has(userId)) this.bets.set(userId, new Map());
    const userBets = this.bets.get(userId);
    if (userBets.has(slot)) throw new Error("Already bet this slot this round");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new Error("Invalid bet amount");

    const newBalance = await walletService.placeBet({
      userId,
      amount,
      game: this.gameId,
      roundId: this.roundId,
    });

    userBets.set(slot, { amount, cashedOut: false, ws });
    return newBalance;
  }

  // Only valid while betting is still open — once the round starts running,
  // the bet is live and there's nothing left to "cancel", only cash out.
  async cancelBet(userId, slot) {
    if (this.phase !== "betting") throw new Error("Too late to cancel — round has already started");
    const userBets = this.bets.get(userId);
    const bet = userBets && userBets.get(slot);
    if (!bet) throw new Error("No bet placed on this slot this round");

    const newBalance = await walletService.refundBet({
      userId,
      amount: bet.amount,
      game: this.gameId,
      roundId: this.roundId,
    });

    userBets.delete(slot);
    return newBalance;
  }

  async cashOut(userId, slot) {
    if (this.phase !== "running") throw new Error("No active round to cash out of");
    const userBets = this.bets.get(userId);
    const bet = userBets && userBets.get(slot);
    if (!bet) throw new Error("No bet placed on this slot this round");
    if (bet.cashedOut) throw new Error("Already cashed out this slot this round");

    // Validated against the server's own elapsed-time calculation — never a
    // client-reported multiplier, since a modified client could send anything.
    const multiplier = this.currentMultiplier();
    if (multiplier >= this.crashPoint) throw new Error("Too late — already crashed");

    const winAmount = Math.round(bet.amount * multiplier * 100) / 100;
    bet.cashedOut = true;
    bet.cashoutMultiplier = multiplier;

    const newBalance = await walletService.creditWin({
      userId,
      amount: winAmount,
      game: this.gameId,
      roundId: this.roundId,
    });

    this.broadcast({ type: "player_cashed_out", multiplier: Math.round(multiplier * 100) / 100, amount: winAmount });
    return { slot, multiplier, winAmount, newBalance };
  }
}

export function createCrashServer(gameId) {
  const wss = new WebSocketServer({ noServer: true });
  const round = new CrashRound(gameId);

  setInterval(() => round.tick(), TICK_MS);

  wss.on("connection", (ws) => {
    let userId = null;
    round.clients.add(ws);

    ws.send(
      JSON.stringify({
        type: "state",
        phase: round.phase,
        roundId: round.roundId,
        seedHash: round.seedHash,
        bettingEndsAt: round.phase === "betting" ? round.bettingEndsAt : null,
        multiplier: Math.round(round.currentMultiplier() * 100) / 100,
        history: round.history.slice(0, 30),
      })
    );

    ws.on("message", async (rawMsg) => {
      let msg;
      try {
        msg = JSON.parse(rawMsg);
      } catch {
        return;
      }

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

      if (msg.type === "bet") {
        if (!userId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
          return;
        }
        const slot = msg.slot ?? 1;
        try {
          const newBalance = await round.placeBet(userId, slot, Number(msg.amount), ws);
          ws.send(JSON.stringify({ type: "bet_accepted", slot, amount: Number(msg.amount), newBalance, roundId: round.roundId }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message || "Bet failed" }));
        }
        return;
      }

      if (msg.type === "cancel") {
        if (!userId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
          return;
        }
        const slot = msg.slot ?? 1;
        try {
          const newBalance = await round.cancelBet(userId, slot);
          ws.send(JSON.stringify({ type: "cancel_accepted", slot, newBalance }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message || "Cancel failed" }));
        }
        return;
      }

      if (msg.type === "cashout") {
        if (!userId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
          return;
        }
        const slot = msg.slot ?? 1;
        try {
          const result = await round.cashOut(userId, slot);
          ws.send(JSON.stringify({ type: "cashout_accepted", ...result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message || "Cashout failed" }));
        }
        return;
      }
    });

    ws.on("close", () => round.clients.delete(ws));
  });

  console.log(`${gameId} WebSocket server ready at /ws/${gameId}`);
  return wss;
}
