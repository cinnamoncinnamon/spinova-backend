import { withTransaction } from "../db/pool.js";
import { emitAdminEvent } from "./adminEvents.js";

// Every function here follows the same non-negotiable pattern from the
// master plan: lock the wallet row with FOR UPDATE before reading the
// balance, so two simultaneous requests can never both read the same
// starting balance and both succeed.

// Wins at or above this amount get pushed to the admin live feed as a
// "big_win" event. Tune via env if ৳1000 isn't the right cutoff for you.
const BIG_WIN_THRESHOLD = Number(process.env.BIG_WIN_THRESHOLD || 1000);

export async function getBalance(userId) {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT balance FROM wallets WHERE user_id = $1",
      [userId]
    );
    return rows[0];
  });
  if (!result) throw new Error("Wallet not found");
  return Number(result.balance);
}

// type: 'deposit' | 'withdraw' | 'bet' | 'win' | 'bonus' | 'refund'
// amount must always be a positive number; direction is determined by type
async function adjustBalance({ userId, type, amount, game = null, roundId = null }, existingClient = null) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid amount");
  }

  const run = async (client) => {
    // Lock the wallet row for the duration of this transaction
    const { rows } = await client.query(
      "SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE",
      [userId]
    );
    const wallet = rows[0];
    if (!wallet) throw new Error("Wallet not found");

    const balanceBefore = Number(wallet.balance);
    const isCredit = type === "deposit" || type === "win" || type === "bonus" || type === "refund";
    const balanceAfter = isCredit ? balanceBefore + amount : balanceBefore - amount;

    if (!isCredit && balanceAfter < 0) {
      throw new Error("Insufficient balance");
    }

    await client.query(
      "UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2",
      [balanceAfter, userId]
    );

    await client.query(
      `INSERT INTO transactions
        (user_id, type, amount, balance_before, balance_after, game, round_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, type, amount, balanceBefore, balanceAfter, game, roundId]
    );

    // Push to the admin live feed. Deposits/withdrawals always; wins only
    // above BIG_WIN_THRESHOLD so the feed isn't drowned in ৳20 slot spins.
    if (type === "deposit" || type === "withdraw") {
      emitAdminEvent(type, { userId, amount, balanceAfter });
    } else if (type === "win" && amount >= BIG_WIN_THRESHOLD) {
      emitAdminEvent("big_win", { userId, amount, game, roundId, balanceAfter });
    }

    return balanceAfter;
  };

  if (existingClient) return run(existingClient);
  return withTransaction(run);
}

export function placeBet({ userId, amount, game, roundId }) {
  return adjustBalance({ userId, type: "bet", amount, game, roundId });
}

export function creditWin({ userId, amount, game, roundId }) {
  return adjustBalance({ userId, type: "win", amount, game, roundId });
}

// Refund a cancelled bet — only ever called while betting is still open
// (before any risk/outcome exists), never after a round has started.
export function refundBet({ userId, amount, game, roundId }) {
  return adjustBalance({ userId, type: "refund", amount, game, roundId });
}

export function recordDeposit({ userId, amount }, existingClient = null) {
  return adjustBalance({ userId, type: "deposit", amount }, existingClient);
}

export function recordWithdraw({ userId, amount }, existingClient = null) {
  return adjustBalance({ userId, type: "withdraw", amount }, existingClient);
}

// Refund a withdrawal that admin rejected — the amount was already deducted
// when the user submitted the request (see routes/withdrawal.js), so this
// puts it back. existingClient lets the caller compose this with the
// withdrawal_requests status update in one atomic transaction.
export function refundWithdrawal({ userId, amount }, existingClient = null) {
  return adjustBalance({ userId, type: "refund", amount }, existingClient);
}

// Used by promo code redemption and admin gifts — anything that credits a
// player without them having deposited, won, or been refunded real money.
export function creditBonus({ userId, amount }, existingClient = null) {
  return adjustBalance({ userId, type: "bonus", amount }, existingClient);
}
