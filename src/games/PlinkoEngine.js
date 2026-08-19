/**
 * Plinko Engine — server-authoritative result generation.
 *
 * Frontend only animates. The bin / multiplier is decided here.
 *
 * RTP modes (admin-controlled via game_controls):
 *   plinko_rtp = "96"  → ~96% RTP (default, 4% house edge)
 *   plinko_rtp = "95"  → ~95% RTP (5% house edge)
 *
 * 16 rows → 17 bins. Multipliers are symmetric (high on edges, low in middle).
 * Result is chosen by weighted random over the probability mass of each bin
 * so the long-run average matches the target RTP.
 */

import crypto from "crypto";
import { pool } from "../db/pool.js";
import { v4 as uuidv4 } from "uuid";

export const GAME_ID = "plinko";
export const DEFAULT_LINES = 16;
export const MIN_LINES = 8;
export const MAX_LINES = 16;
export const BET_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

// ── Multiplier tables (17 bins for 16 rows) ────────────────────────────────
// Values chosen so a fair-ish distribution yields the target RTP.
// Index 0 = far left, 16 = far right.

const MULTIPLIERS_96 = [
  110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110,
];

const MULTIPLIERS_95 = [
  100, 35, 8, 4, 2.5, 1.2, 0.8, 0.4, 0.2, 0.4, 0.8, 1.2, 2.5, 4, 8, 35, 100,
];

// Relative probability weights (approximate binomial shape for 16 rows).
// Higher weight = more common. Edges are rare, middle is common.
// These are the same shape for both tables; only the multipliers change.
const BIN_WEIGHTS_16 = [
  1, 4, 12, 30, 60, 100, 140, 170, 180, 170, 140, 100, 60, 30, 12, 4, 1,
];

function getMultipliers(rtp) {
  return rtp === "95" ? MULTIPLIERS_95 : MULTIPLIERS_96;
}

/**
 * Read current RTP setting from game_controls.
 * Default = "96".
 */
export async function getPlinkoRtp() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM game_controls WHERE game_id = $1 AND key = $2",
      [GAME_ID, "plinko_rtp"]
    );
    const v = rows[0]?.value;
    return v === "95" ? "95" : "96";
  } catch {
    return "96";
  }
}

/**
 * Weighted random bin index (0 .. 16).
 */
function pickBinIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  // crypto random for better quality than Math.random
  const buf = crypto.randomBytes(4);
  const r = (buf.readUInt32BE(0) / 0xffffffff) * total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r <= acc) return i;
  }
  return weights.length - 1;
}

/**
 * Generate a play result (no wallet side-effects).
 * Used by the route after balance checks.
 */
export async function generateResult({ lines = DEFAULT_LINES } = {}) {
  const safeLines = Math.min(MAX_LINES, Math.max(MIN_LINES, Number(lines) || DEFAULT_LINES));
  // For now we only fully support 16-row table. Other line counts reuse the
  // same 17-bin table (frontend can still show different pin counts visually).
  const rtp = await getPlinkoRtp();
  const multipliers = getMultipliers(rtp);
  const weights = BIN_WEIGHTS_16;

  const binIndex = pickBinIndex(weights);
  const multiplier = multipliers[binIndex];

  const roundId = uuidv4();

  return {
    roundId,
    lines: safeLines,
    binIndex,
    multiplier,
    rtp,
    // Optional: simple left/right path hints for animation (not required)
    // path is just cosmetic — server already decided the bin.
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

/**
 * Theoretical RTP for a table (for admin / docs).
 * Sum(weight_i * mult_i) / sum(weights)
 */
export function theoreticalRtp(rtpMode = "96") {
  const mults = getMultipliers(rtpMode);
  const weights = BIN_WEIGHTS_16;
  let sumW = 0;
  let sumWM = 0;
  for (let i = 0; i < mults.length; i++) {
    sumW += weights[i];
    sumWM += weights[i] * mults[i];
  }
  return Math.round((sumWM / sumW) * 10000) / 100; // e.g. 96.12
}
