/**
 * Plinko Engine — server-authoritative, provably-fair style path.
 *
 * - 16 rows → 17 bins
 * - Each row is exact 50/50 (crypto random) → binomial(16, 0.5)
 * - Risk tables (low / medium / high) scaled to ~96% RTP (≈4% house edge)
 * - Returns full L/R path so the client can animate exactly like the reference game
 */

import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

export const GAME_ID = "plinko";
export const ROWS = 16;
export const BUCKETS = ROWS + 1;
export const DEFAULT_LINES = 16;
export const MIN_LINES = 16; // fixed 16-row board (matches reference game)
export const MAX_LINES = 16;
export const BET_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/** @typedef {"low"|"medium"|"high"} Risk */

/**
 * Multiplier tables — same shape as Stake/Aztec reference, scaled to ~96% RTP
 * under true binomial(16, 0.5) probabilities.
 *
 * Verified EV:
 *   low    ≈ 95.97%
 *   medium ≈ 95.76%
 *   high   ≈ 95.69%
 */
export const MULTIPLIERS = {
  low: [
    15.5, 8.7, 1.94, 1.36, 1.36, 1.16, 1.07, 0.97, 0.48,
    0.97, 1.07, 1.16, 1.36, 1.36, 1.94, 8.7, 15.5,
  ],
  medium: [
    106.7, 39.8, 9.7, 4.85, 2.91, 1.45, 0.97, 0.48, 0.29,
    0.48, 0.97, 1.45, 2.91, 4.85, 9.7, 39.8, 106.7,
  ],
  high: [
    970, 126, 25.2, 8.73, 3.88, 1.94, 0.19, 0.19, 0.19,
    0.19, 0.19, 1.94, 3.88, 8.73, 25.2, 126, 970,
  ],
};

export const RISKS = /** @type {Risk[]} */ (["low", "medium", "high"]);

/**
 * True binomial path: each of 16 rows is an independent fair coin flip.
 * binIndex = number of "right" moves (0 .. 16).
 */
function generatePath() {
  const buf = crypto.randomBytes(ROWS);
  const path = [];
  for (let i = 0; i < ROWS; i++) {
    path.push(buf[i] & 1); // 0 = left, 1 = right
  }
  const binIndex = path.reduce((a, b) => a + b, 0);
  return { path, binIndex };
}

/**
 * @param {{ risk?: Risk }} opts
 */
export async function generateResult({ risk = "medium" } = {}) {
  const safeRisk = RISKS.includes(risk) ? risk : "medium";
  const table = MULTIPLIERS[safeRisk];
  const { path, binIndex } = generatePath();
  const multiplier = table[binIndex];
  const roundId = uuidv4();

  return {
    roundId,
    lines: ROWS,
    risk: safeRisk,
    path,
    binIndex,
    multiplier,
    rtp: "96",
  };
}

export function isValidBet(amount) {
  return (
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    amount > 0 &&
    BET_STEPS.includes(amount)
  );
}

export function isValidRisk(risk) {
  return RISKS.includes(risk);
}

/**
 * Theoretical RTP for a risk table under binomial(16, 0.5).
 */
export function theoreticalRtp(risk = "medium") {
  const mults = MULTIPLIERS[RISKS.includes(risk) ? risk : "medium"];
  const n = 1 << ROWS;
  function binom(nn, k) {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (nn - i)) / (i + 1);
    return Math.round(r);
  }
  let ev = 0;
  for (let k = 0; k <= ROWS; k++) {
    ev += (binom(ROWS, k) / n) * mults[k];
  }
  return Math.round(ev * 10000) / 100; // e.g. 95.76
}

/** Display helpers for /info */
export function getTables() {
  return {
    low: MULTIPLIERS.low,
    medium: MULTIPLIERS.medium,
    high: MULTIPLIERS.high,
  };
}
