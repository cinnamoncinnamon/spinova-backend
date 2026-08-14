import crypto from "crypto";
import { redis } from "../../db/redis.js";

// ── Ported unchanged from rx8/src/games/slots/tombraiders/TombRaidersSlot.jsx ──
// Every weight, payline, forced-roll tier, jackpot rule, and free-spin number
// below is copied exactly from the original client code. The ONE thing that
// changed on purpose: the Gamble feature used to flip its own coin in the
// browser (`Math.random()<0.5`) and directly mutate local balance state —
// meaning anyone could force it to always win via devtools. It's now a real
// server-side decision, using the same fair 50/50 odds, just decided
// somewhere a player can't reach.

export const ROWS = 3;
export const COLS = 5;

const SYMBOLS = [
  { id: "lara", pay: [2, 10, 40], weight: 3 },
  { id: "idol", pay: [2, 8, 30], weight: 4 },
  { id: "chest", pay: [1, 5, 20], weight: 5 },
  { id: "map", pay: [1, 4, 15], weight: 6 },
  { id: "key", pay: [1, 3, 12], weight: 7 },
  { id: "gem", pay: [1, 3, 10], weight: 7 },
  { id: "torch", pay: [1, 2, 8], weight: 8 },
  { id: "relic", pay: [1, 2, 6], weight: 9 },
  { id: "wild", pay: [3, 12, 35], wild: true, weight: 2 },
  { id: "scat", pay: [0, 0, 0], scatter: true, weight: 1 },
];
const BY_ID = Object.fromEntries(SYMBOLS.map((s) => [s.id, s]));
const WEIGHTED = SYMBOLS.flatMap((s) => Array(s.weight).fill(s.id));

function pickWeighted() {
  return WEIGHTED[Math.floor(Math.random() * WEIGHTED.length)];
}

const PAYLINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 1, 2, 1], [1, 2, 1, 0, 1], [0, 1, 1, 1, 2],
];

export const BET_STEPS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
// Line pay factors (after mult × bet × free-spin multiplier):
// small wins stay near full so the game still "dings"; bigger wins stay taxed.
const PAYOUT_FACTOR_BIG = 0.52;   // natural line > SMALL_WIN_MULT × bet
const PAYOUT_FACTOR_SMALL = 0.72; // base-game small hooks only
const SMALL_WIN_MULT = 2;
// Base: void only medium/big. Free spins: may void any cash.
const PURE_EDGE = 0.02;
// Hard cap on cash paid this spin (and on gamble doubles) in ৳.
const MAX_EXPOSURE = 3000;
const JACKPOTS = { mini: 2, minor: 3, major: 4, grand: 5 };
const FREE_SPINS_AWARD = { 3: 5, 4: 8, 5: 12 };
const FREE_SPINS_RETRIGGER = 3;
const MULT_TIERS = [1, 1, 2, 3];
const MULT_TIER_INTERVAL = 4;
const GAMBLE_MAX_ROUNDS = 3;

function currentFreeMult(total, remaining) {
  if (total <= 0) return 1;
  const used = Math.max(0, total - remaining);
  const idx = Math.min(MULT_TIERS.length - 1, Math.floor(used / MULT_TIER_INTERVAL));
  return MULT_TIERS[idx];
}

// Grid generation — three forced-roll tiers layered on top of the natural
// weighted pool, exactly matching the client's roll<0.04/0.12/0.34 branches.
function generateGrid() {
  const target = Array.from({ length: COLS }, () =>
    Array.from({ length: ROWS }, () => ({ sym: pickWeighted() }))
  );
  const roll = Math.random();
  if (roll < 0.04) {
    const rows = [0, 1, 2];
    const cols = [0, 1, 2, 3, 4].sort(() => Math.random() - 0.5).slice(0, 3);
    cols.forEach((c) => { target[c][rows[Math.floor(Math.random() * 3)]].sym = "scat"; });
  } else if (roll < 0.12) {
    const sId = ["key", "map", "gem"][Math.floor(Math.random() * 3)];
    target[0][1].sym = sId; target[1][1].sym = sId; target[2][1].sym = sId;
  } else if (roll < 0.34) {
    const sId = ["torch", "relic"][Math.floor(Math.random() * 2)];
    target[0][1].sym = sId; target[1][1].sym = sId; target[2][1].sym = sId;
  }
  return target;
}

// Identical rule set to the client's evaluate(): wild substitution, 3/4/5-of-
// a-kind pay tiers per payline, and jackpot tier assignment on a 5-match or
// 5+ scatters anywhere.
function evaluate(g) {
  const lines = []; let totalMult = 0, jackpot = null;
  const jackpotRank = { mini: 1, minor: 2, major: 3, grand: 4 };
  const setJackpot = (tier) => { if (!jackpot || jackpotRank[tier] > jackpotRank[jackpot]) jackpot = tier; };

  PAYLINES.forEach((line, idx) => {
    const firstSymId = (() => {
      const s = g[0][line[0]].sym;
      if (s === "scat") return null;
      if (s === "wild") {
        for (let c = 1; c < COLS; c++) {
          const x = g[c][line[c]].sym;
          if (x !== "wild" && x !== "scat") return x;
        }
        return "wild";
      }
      return s;
    })();
    if (!firstSymId) return;

    let matches = 1;
    for (let c = 1; c < COLS; c++) {
      const s = g[c][line[c]].sym;
      if (s === firstSymId || s === "wild") matches++;
      else break;
    }
    if (matches >= 3) {
      const sym = BY_ID[firstSymId], m = sym.pay[matches - 3];
      if (m > 0) { totalMult += m; lines.push(idx); }
      if (matches === 5) {
        if (firstSymId === "wild") setJackpot("grand");
        else if (firstSymId === "lara") setJackpot("major");
        else if (firstSymId === "idol") setJackpot("minor");
        else setJackpot("mini");
      }
    }
  });

  let scatters = 0;
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (g[c][r].sym === "scat") scatters++;
  if (scatters >= 5) setJackpot("minor");

  return { totalMult, lines, scatters, jackpot };
}

// ── Per-session state (free spins, multiplier tier, pending gamble) ────────
// Keyed by whatever the caller passes as `sessionId` — same pattern as
// Golden Relics, so the reset-on-refresh behavior stays consistent.
const SESSION_KEY = (sessionId) => `slots:tombraiders:session:${sessionId}`;
const LOCK_KEY = (sessionId) => `slots:tombraiders:lock:${sessionId}`;

async function loadSession(sessionId) {
  const raw = await redis.get(SESSION_KEY(sessionId));
  if (raw) return JSON.parse(raw);
  return { freeSpins: 0, freeSpinsTotal: 0, pendingGamble: null };
}
async function saveSession(sessionId, session) {
  await redis.set(SESSION_KEY(sessionId), JSON.stringify(session));
}

export async function acquireSpinLock(sessionId) {
  const result = await redis.set(LOCK_KEY(sessionId), "1", "PX", 5000, "NX");
  return result === "OK";
}
export async function releaseSpinLock(sessionId) {
  await redis.del(LOCK_KEY(sessionId));
}

export async function peekFreeSpinsRemaining(sessionId) {
  const session = await loadSession(sessionId);
  return session.freeSpins;
}

export async function spinTombRaiders({ sessionId, bet }) {
  const session = await loadSession(sessionId);
  const usingFreeSpin = session.freeSpins > 0;
  if (usingFreeSpin) session.freeSpins -= 1;

  const activeMult = currentFreeMult(session.freeSpinsTotal, session.freeSpins);
  const grid = generateGrid();
  const ev = evaluate(grid);

  // Natural line before house factors (includes free-spin multiplier).
  const rawLine = ev.lines.length ? ev.totalMult * bet * activeMult : 0;
  const smallThreshold = SMALL_WIN_MULT * bet;
  // Free spins: always big tax. Base: small factor only for ≤2× bet lines.
  const lineFactor = usingFreeSpin
    ? PAYOUT_FACTOR_BIG
    : rawLine > 0 && rawLine <= smallThreshold
      ? PAYOUT_FACTOR_SMALL
      : PAYOUT_FACTOR_BIG;
  let lineWin = rawLine > 0 ? Math.max(1, Math.floor(rawLine * lineFactor)) : 0;
  let jackpotWin = ev.jackpot ? Math.floor(JACKPOTS[ev.jackpot] * bet) : 0;
  let totalWin = lineWin + jackpotWin;

  // Cap + pure edge (cash only; free-spin awards untouched below).
  if (totalWin > MAX_EXPOSURE) {
    const scale = MAX_EXPOSURE / totalWin;
    lineWin = Math.floor(lineWin * scale);
    jackpotWin = Math.floor(jackpotWin * scale);
    totalWin = lineWin + jackpotWin;
    if (totalWin > MAX_EXPOSURE) totalWin = MAX_EXPOSURE;
  }
  const edgeApplies = usingFreeSpin
    ? totalWin > 0
    : totalWin >= smallThreshold;
  if (edgeApplies && Math.random() < PURE_EDGE) {
    lineWin = 0;
    jackpotWin = 0;
    totalWin = 0;
  }

  // Scatter free spins — independent of cash void/cap (bonus feature stays fair).
  let freeSpinsAwarded = 0;
  if (ev.scatters >= 3) {
    const isRetrigger = session.freeSpins > 0 || session.freeSpinsTotal > 0;
    freeSpinsAwarded = isRetrigger ? FREE_SPINS_RETRIGGER : FREE_SPINS_AWARD[ev.scatters] || 10;
    session.freeSpins += freeSpinsAwarded;
    session.freeSpinsTotal += freeSpinsAwarded;
  }
  if (session.freeSpins === 0) session.freeSpinsTotal = 0;

  // Gamble only on positive cash after edge/cap; never on jackpots.
  if (totalWin > 0 && !ev.jackpot) {
    session.pendingGamble = { amount: totalWin, round: 0 };
  } else {
    session.pendingGamble = null;
  }

  await saveSession(sessionId, session);

  return {
    grid: grid.map((col) => col.map((cell) => cell.sym)),
    lines: ev.lines,
    lineWin,
    jackpotWin,
    jackpot: ev.jackpot,
    totalWin,
    scatters: ev.scatters,
    freeSpinsAwarded,
    freeSpinsRemaining: session.freeSpins,
    multiplier: activeMult,
    usingFreeSpin,
    gambleAvailable: !!session.pendingGamble,
    gambleAmount: session.pendingGamble ? session.pendingGamble.amount : 0,
  };
}

// Real coin flip, decided here — not in the browser. `pick` is whatever the
// player chose ("red"/"black"); win chance is the same fair 50/50 the
// original client used, just no longer forgeable.
export async function resolveGambleTombRaiders({ sessionId, pick }) {
  const session = await loadSession(sessionId);
  if (!session.pendingGamble) {
    throw Object.assign(new Error("No gamble in progress."), { status: 400 });
  }

  const result = Math.random() < 0.5 ? "red" : "black";
  const won = pick === result;
  const before = session.pendingGamble.amount;
  const round = session.pendingGamble.round;

  if (won) {
    // Cap gamble ladder so doubles cannot exceed MAX_EXPOSURE.
    const doubled = Math.min(before * 2, MAX_EXPOSURE);
    const nextRound = round + 1;
    const hitCap = doubled >= MAX_EXPOSURE;
    const maxedOut = nextRound >= GAMBLE_MAX_ROUNDS || hitCap;
    session.pendingGamble = maxedOut ? null : { amount: doubled, round: nextRound };
    await saveSession(sessionId, session);
    return {
      won: true,
      amount: doubled,
      delta: doubled - before,
      round: nextRound,
      maxedOut,
      gambleAvailable: !maxedOut,
    };
  } else {
    session.pendingGamble = null;
    await saveSession(sessionId, session);
    return { won: false, amount: 0, delta: -before, round, maxedOut: true, gambleAvailable: false };
  }
}

// Player chooses to walk away with the current gamble amount instead of
// risking it further — server just clears the pending state, no payout
// change (the amount was already credited to the wallet as a normal win by
// the spin route; gambling only adjusts it further from there).
export async function collectGambleTombRaiders({ sessionId }) {
  const session = await loadSession(sessionId);
  session.pendingGamble = null;
  await saveSession(sessionId, session);
  return { ok: true };
}
