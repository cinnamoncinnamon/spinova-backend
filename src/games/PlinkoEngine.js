/**
 * Plinko Engine — SERVER AUTHORITATIVE
 * - True 50/50 per row → binomial(16, 0.5)
 * - Risk tables calibrated to ~96% RTP (~4% house edge)
 * - Returns full path[] so client only animates
 */
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

export const GAME_ID = "plinko";
export const ROWS = 16;
export const BUCKETS = ROWS + 1;
export const BET_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/** @typedef {"low"|"medium"|"high"} Risk */

/**
 * ~96% RTP under binomial(16, 0.5)
 * low ≈ 95.97% | medium ≈ 95.76% | high ≈ 95.69%
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

function generatePath() {
  const buf = crypto.randomBytes(ROWS);
  const path = [];
  for (let i = 0; i < ROWS; i++) path.push(buf[i] & 1);
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
  return {
    roundId: uuidv4(),
    lines: ROWS,
    risk: safeRisk,
    path,
    binIndex,
    multiplier: table[binIndex],
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

export function theoreticalRtp(risk = "medium") {
  const mults = MULTIPLIERS[RISKS.includes(risk) ? risk : "medium"];
  const n = 1 << ROWS;
  function binom(nn, k) {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (nn - i)) / (i + 1);
    return Math.round(r);
  }
  let ev = 0;
  for (let k = 0; k <= ROWS; k++) ev += (binom(ROWS, k) / n) * mults[k];
  return Math.round(ev * 10000) / 100;
}

export function getTables() {
  return { low: MULTIPLIERS.low, medium: MULTIPLIERS.medium, high: MULTIPLIERS.high };
}
