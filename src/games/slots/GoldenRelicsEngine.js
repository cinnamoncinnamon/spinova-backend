import { redis } from "../../db/redis.js";

// ── Ported from rx8/src/games/slots/goldenrelics ────────────────────────────
// Symbol pay table & weights: .../goldenrelics/symbols.jsx
// Grid size, jackpot constants, bonus constants: .../goldenrelics/GoldenRelicsSlot.jsx
// These numbers are the original design and were kept unchanged EXCEPT the
// two values explicitly called out below.
export const REELS = 5;
export const ROWS = 3;
const SCATTER = "poseidon";

// ── Safety fix: base-game RTP (session: same category, opposite direction) ─
// The original pay table paid out an expected ~5.2% of stake on the base
// game (verified analytically and via a 2,000,000-spin simulation — not
// sample noise). Real-money slots are typically 85-97% RTP; anything under
// ~85% is essentially unheard of in licensed markets and reads as an
// obvious rip-off rather than a competitive game. This isn't a liability
// bug like the free-spins or jackpot issues (it doesn't cost the house
// money) — it's a balance issue in the other direction. Values below are
// the original pay table scaled up ~17x uniformly, which preserves the
// original relative ordering and "feel" (poseidon still pays the most,
// coin, at ~15x. (First pass at 17x was tested via simulation and
// overshot to 103.89% total RTP once free-spin frequency/multiplier and
// the jackpot were factored in — win amount scales exactly linearly with
// these values since frequency doesn't depend on pay table, so this was a
// direct correction from that measurement, not a re-guess.) Final result
// verified by simulation: ~92% total RTP blended across base game, free
// spins, and jackpot.
export const SYMBOL_PAY = {
  poseidon: 750, trident: 375, crown: 300, chest: 225, octopus: 150,
  turtle: 120, sapphire: 90, anchor: 75, pearl: 60, coin: 45,
};
export const SYMBOL_WEIGHT = {
  poseidon: 1, trident: 2, crown: 3, chest: 4, octopus: 6,
  turtle: 10, sapphire: 14, anchor: 20, pearl: 26, coin: 34,
};
const SYMBOLS = Object.keys(SYMBOL_PAY);

// Weighted pool for non-scatter symbols — scatter is rolled separately below,
// same split as the client's _pk()/_bg() helpers.
const WEIGHTED_POOL = (() => {
  const pool = [];
  for (const s of SYMBOLS) {
    if (s === SCATTER) continue;
    const w = SYMBOL_WEIGHT[s] ?? 1;
    for (let i = 0; i < w; i++) pool.push(s);
  }
  return pool;
})();

const BASE_SCATTER_AWARD = 10;   // free spins on a fresh trigger (outside bonus)
const RETRIGGER_AWARD = 5;       // free spins on a retrigger (inside bonus)
const BONUS_WIN_MULTIPLIER = 3;  // all wins during free spins pay 3x

// ── Safety fixes (session: economic bug in free-spins math) ────────────────
// Original client value was 0.14 for in-bonus scatter chance. At that rate,
// the retrigger probability (~35%, verified via 20,000-spin simulation) times
// the retrigger award (5) gives a reproduction rate of ~1.76 — each bonus
// round mathematically tends to generate MORE free spins than it consumes,
// with no guaranteed end. A single early trigger could consume a 20,000-spin
// test run almost entirely.
//
// Fix 1: scatter chance during free spins reduced 0.14 -> 0.07. This drops
// the reproduction rate to ~0.41 (retrigger probability ~8.3% x award 5),
// comfortably below 1, while leaving the "+5 free spins" number players see
// on screen unchanged.
const FREE_SPIN_SCATTER_CHANCE = 0.07;
const NORMAL_SCATTER_CHANCE = 0.02; // unchanged

// Fix 2: hard cap on total free spins awarded within a single bonus round
// (first trigger + every retrigger), independent of the odds above. This is
// the backstop that bounds worst-case liability even if the odds are ever
// wrong again — intentionally redundant with Fix 1, not a substitute for it.
export const MAX_FREE_SPINS_PER_BONUS = 75;

const JACKPOT_SEED = 50000;
const JACKPOT_CONTRIBUTION_RATE = 0.02; // unchanged — this portion is fine: it's
// money fed into the pool by real bets and mathematically comes back out to
// players over time regardless of hit odds, similar to how real progressive
// jackpots are funded. Not the source of the bug below.

// ── Safety fix: jackpot hit rate (session: same bug pattern as free spins) ─
// Original client values were JACKPOT_BASE_CHANCE=0.00015 and
// JACKPOT_BET_BONUS=0.0005 with NO cap on how far bet size could push the
// odds. At a ৳500 bet that worked out to a ~24.8% chance of hitting a
// ৳50,000 jackpot on every single spin (verified: 62 jackpot hits in under
// 19,000 simulated ৳10-bet spins, contributing 1646% RTP on its own). This
// was invisible with fake client-side money because nobody stress-tests a
// ৳500 bet with play money.
//
// Fix: hit chance reduced by ~75x at the base, ~10,000x on the per-bet
// scaling term, AND the bet-scaling is capped at JACKPOT_ODDS_CAP_BET so it
// can no longer run away at high bets. Verified via simulation: this lands
// hit rates around 1-in-150,000 to 1-in-500,000 spins depending on bet size,
// with the jackpot line contributing a steady ~2-3% of RTP — in line with
// how real progressive jackpots are typically budgeted, instead of
// dominating the entire payout table.
const JACKPOT_BASE_CHANCE = 0.000002;   // was 0.00015
const JACKPOT_BET_BONUS = 0.00000005;   // was 0.0005
// Pure house edge: void positive cash (lines + jackpot) with this probability.
// Base engine ~92% RTP; 4% voids → roughly ~88% effective.
const PURE_EDGE = 0.04;
// Hard cap on cash paid this spin (৳). Free-spin awards are not voided.
const MAX_EXPOSURE = 3000;
const JACKPOT_ODDS_CAP_BET = 100;       // bets above this no longer raise jackpot odds further

export const MIN_BET = 1;
export const MAX_BET = 1000;

export function isValidBet(bet) {
  return Number.isInteger(bet) && bet >= MIN_BET && bet <= MAX_BET;
}

function pickSymbol() {
  return WEIGHTED_POOL[Math.floor(Math.random() * WEIGHTED_POOL.length)];
}

function pickCell(scatterChance) {
  return Math.random() < scatterChance ? SCATTER : pickSymbol();
}

function generateGrid(scatterChance) {
  const grid = [];
  for (let c = 0; c < REELS; c++) {
    const col = [];
    for (let r = 0; r < ROWS; r++) col.push(pickCell(scatterChance));
    grid.push(col);
  }
  return grid;
}

function countScatters(grid) {
  let count = 0;
  for (let c = 0; c < REELS; c++)
    for (let r = 0; r < ROWS; r++)
      if (grid[c][r] === SCATTER) count++;
  return count;
}

// Left-to-right consecutive match per row — identical rule to the client's
// evaluateWins(), including the 4-of-a-kind/5-of-a-kind pay bumps.
export function evaluateWins(grid, bet, multiplier) {
  const wins = [];
  for (let r = 0; r < ROWS; r++) {
    const symbol = grid[0][r];
    let count = 1;
    for (let c = 1; c < REELS; c++) {
      if (grid[c][r] === symbol) count++;
      else break;
    }
    if (count >= 3) {
      const payBump = count === 5 ? 5 : count === 4 ? 2 : 1;
      const amount = Math.round((bet / 10) * SYMBOL_PAY[symbol] * payBump * multiplier);
      wins.push({ row: r, cols: Array.from({ length: count }, (_, i) => i), symbol, amount });
    }
  }
  return wins;
}

// ── Per-user session state ──────────────────────────────────────────────────
// Holds free-spins-remaining, the in-progress bonus-round spin budget, and
// the jackpot pool. Per your call: NOT a shared pool across players — each
// user gets their own jackpot value in Redis. Persists across requests
// (unlike the original client's React state, which reset on page refresh);
// flagging this as a deliberate improvement, not an oversight — happy to make
// it expire/reset on a timer instead if you'd rather match the old behavior
// exactly.
const SESSION_KEY = (userId) => `slots:goldenrelics:session:${userId}`;
const LOCK_KEY = (userId) => `slots:goldenrelics:lock:${userId}`;

async function loadSession(userId) {
  const raw = await redis.get(SESSION_KEY(userId));
  if (raw) return JSON.parse(raw);
  return { jackpot: JACKPOT_SEED, freeSpinsRemaining: 0, spinsAwardedThisBonus: 0, freeSpinBet: 0 };
}

async function saveSession(userId, session) {
  await redis.set(SESSION_KEY(userId), JSON.stringify(session));
}

export async function peekFreeSpinsRemaining(userId) {
  const session = await loadSession(userId);
  return session.freeSpinsRemaining;
}

// Prevents two concurrent spin requests for the same user from racing each
// other (e.g. a rapid double-click both reading "1 free spin left" before
// either one decrements it). Short TTL is a safety net in case the process
// crashes mid-spin and never releases the lock.
export async function acquireSpinLock(userId) {
  const result = await redis.set(LOCK_KEY(userId), "1", "PX", 5000, "NX");
  return result === "OK";
}
export async function releaseSpinLock(userId) {
  await redis.del(LOCK_KEY(userId));
}

// Computes one spin's outcome and updates session state (free spins,
// jackpot). Does NOT touch the wallet — the route owns bet deduction and win
// crediting via walletService, using the values this function returns.
export async function spin({ userId, bet }) {
  if (!isValidBet(bet)) {
    throw new Error(`Invalid bet amount. Must be a whole number between ${MIN_BET} and ${MAX_BET}.`);
  }

  const session = await loadSession(userId);
  const usingFreeSpin = session.freeSpinsRemaining > 0;

  // ── Security fix: lock the payout-scaling bet during free spins ──────────
  // Free spins don't deduct the wallet, so the "bet" used to size the win
  // must NOT come from the current request — a player could trigger the
  // bonus at the minimum bet, then send an arbitrary higher `amount` on the
  // free-spin requests themselves (bypassing the client's disabled bet UI
  // via a direct API call) and get paid out at that inflated scale for
  // free. effectiveBet is what all payout math below actually uses.
  const effectiveBet = usingFreeSpin ? (session.freeSpinBet || bet) : bet;

  if (usingFreeSpin) {
    session.freeSpinsRemaining -= 1;
  } else {
    session.jackpot = Math.round((session.jackpot + bet * JACKPOT_CONTRIBUTION_RATE) * 100) / 100;
  }

  // Jackpot roll only on a real (non-free) spin, matching the client.
  // Bet size influence on the odds is capped at JACKPOT_ODDS_CAP_BET —
  // see the comment on the jackpot constants above for why.
  const jackpotOddsBet = Math.min(bet, JACKPOT_ODDS_CAP_BET);
  const jackpotWon =
    !usingFreeSpin && Math.random() < JACKPOT_BASE_CHANCE + Math.max(0, jackpotOddsBet - 5) * JACKPOT_BET_BONUS;

  const scatterChance = usingFreeSpin ? FREE_SPIN_SCATTER_CHANCE : NORMAL_SCATTER_CHANCE;
  const grid = generateGrid(scatterChance);
  const winMultiplier = usingFreeSpin ? BONUS_WIN_MULTIPLIER : 1;
  const wins = evaluateWins(grid, effectiveBet, winMultiplier);
  let winAmount = wins.reduce((sum, w) => sum + w.amount, 0);
  const scatterCount = countScatters(grid);

  let freeSpinsAwarded = 0;
  let bonusTriggered = false;
  let bonusCapped = false;

  if (scatterCount >= 3) {
    bonusTriggered = true;
    const isRetrigger = usingFreeSpin;
    const rawAward = isRetrigger ? RETRIGGER_AWARD : BASE_SCATTER_AWARD;

    // A fresh (non-retrigger) hit starts a new bonus round's spin budget
    // and locks in the bet that will be used for every spin in it —
    // retriggers keep the bet that started the round, they don't re-lock.
    if (!isRetrigger) {
      session.spinsAwardedThisBonus = 0;
      session.freeSpinBet = bet;
    }

    const remainingBudget = MAX_FREE_SPINS_PER_BONUS - session.spinsAwardedThisBonus;
    freeSpinsAwarded = Math.max(0, Math.min(rawAward, remainingBudget));
    if (freeSpinsAwarded < rawAward) bonusCapped = true;

    session.spinsAwardedThisBonus += freeSpinsAwarded;
    session.freeSpinsRemaining += freeSpinsAwarded;
  }

  let jackpotAmount = 0;
  let jackpotActuallyWon = false;
  if (jackpotWon) {
    jackpotAmount = session.jackpot;
    session.jackpot = JACKPOT_SEED;
    jackpotActuallyWon = true;
  }

  // Pure edge + cap on combined cash (lines + jackpot). Free-spin awards stay.
  let cash = winAmount + jackpotAmount;
  if (cash > MAX_EXPOSURE && cash > 0) {
    const scale = MAX_EXPOSURE / cash;
    winAmount = Math.round(winAmount * scale * 100) / 100;
    jackpotAmount = Math.round(jackpotAmount * scale * 100) / 100;
    cash = winAmount + jackpotAmount;
    if (cash > MAX_EXPOSURE) {
      winAmount = Math.min(winAmount, MAX_EXPOSURE);
      jackpotAmount = Math.max(0, MAX_EXPOSURE - winAmount);
      cash = winAmount + jackpotAmount;
    }
  }
  // Base: protect small hooks (< 2× bet). Free spins: edge may void any cash.
  const smallThreshold = 2 * effectiveBet;
  const edgeApplies = usingFreeSpin ? cash > 0 : cash >= smallThreshold;
  if (edgeApplies && Math.random() < PURE_EDGE) {
    // Void cash; restore jackpot pool if we had taken it.
    if (jackpotActuallyWon) {
      session.jackpot = jackpotAmount;
      jackpotActuallyWon = false;
      jackpotAmount = 0;
    }
    winAmount = 0;
    cash = 0;
  }

  if (session.freeSpinsRemaining === 0) session.freeSpinBet = 0;

  await saveSession(userId, session);

  return {
    grid,
    wins,
    winAmount,
    scatterCount,
    usingFreeSpin,
    freeSpinsAwarded,
    freeSpinsRemaining: session.freeSpinsRemaining,
    bonusTriggered,
    bonusCapped,
    jackpotWon: jackpotActuallyWon,
    jackpotAmount,
    jackpotCurrent: session.jackpot,
    winMultiplier,
  };
}