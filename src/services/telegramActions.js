// Shared approve/reject logic for deposit and withdrawal requests.
// This is the SAME logic that used to live only inline in routes/admin.js —
// extracted here so both the admin HTTP endpoints and the Telegram bot's
// inline-button handlers call one real implementation instead of two
// copies that could drift out of sync.
import { pool, withTransaction } from "../db/pool.js";
import * as walletService from "./walletService.js";

export async function approveDepositRequest(id, adminNote = null) {
  const request = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM deposit_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const depReq = rows[0];
    if (!depReq) throw new Error("NOT_FOUND");
    if (depReq.status !== "pending") throw new Error("ALREADY_PROCESSED");

    await walletService.recordDeposit(
      { userId: depReq.user_id, amount: Number(depReq.amount) },
      client
    );

    await client.query(
      `UPDATE deposit_requests SET
        status = 'approved',
        admin_note = $1,
        reviewed_by = 'admin',
        reviewed_at = NOW()
       WHERE id = $2`,
      [adminNote, id]
    );

    return depReq;
  });

  return { request, message: `৳${request.amount} credited to user's wallet.` };
}

export async function rejectDepositRequest(id, adminNote = "Rejected by admin.") {
  const { rows } = await pool.query(
    `UPDATE deposit_requests SET
      status = 'rejected',
      admin_note = $1,
      reviewed_by = 'admin',
      reviewed_at = NOW()
     WHERE id = $2 AND status = 'pending'
     RETURNING *`,
    [adminNote, id]
  );
  if (!rows[0]) throw new Error("NOT_FOUND");
  return { request: rows[0], message: "Deposit request rejected." };
}

export async function approveWithdrawalRequest(id, adminNote = null) {
  const request = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const wReq = rows[0];
    if (!wReq) throw new Error("NOT_FOUND");
    if (wReq.status !== "pending") throw new Error("ALREADY_PROCESSED");

    await client.query(
      `UPDATE withdrawal_requests SET
        status = 'approved',
        admin_note = $1,
        reviewed_by = 'admin',
        reviewed_at = NOW()
       WHERE id = $2`,
      [adminNote, id]
    );

    return wReq;
  });

  return { request, message: `Marked ৳${request.amount} as paid out to the user.` };
}

export async function rejectWithdrawalRequest(id, adminNote = "Rejected by admin.") {
  const request = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const wReq = rows[0];
    if (!wReq) throw new Error("NOT_FOUND");
    if (wReq.status !== "pending") throw new Error("ALREADY_PROCESSED");

    await walletService.refundWithdrawal(
      { userId: wReq.user_id, amount: Number(wReq.amount) },
      client
    );

    await client.query(
      `UPDATE withdrawal_requests SET
        status = 'rejected',
        admin_note = $1,
        reviewed_by = 'admin',
        reviewed_at = NOW()
       WHERE id = $2`,
      [adminNote, id]
    );

    return wReq;
  });

  return { request, message: `৳${request.amount} refunded to user's wallet.` };
}

// Pending counts + lists for the /pending command
export async function getPendingSummary() {
  const [depositRows, withdrawalRows] = await Promise.all([
    pool.query(
      `SELECT dr.id, dr.amount, dr.method, dr.account_number, dr.transaction_id, dr.created_at, u.mobile, u.name
       FROM deposit_requests dr JOIN users u ON dr.user_id = u.id
       WHERE dr.status = 'pending' ORDER BY dr.created_at ASC LIMIT 20`
    ),
    pool.query(
      `SELECT wr.id, wr.amount, wr.method, wr.account_details, wr.created_at, u.mobile, u.name
       FROM withdrawal_requests wr JOIN users u ON wr.user_id = u.id
       WHERE wr.status = 'pending' ORDER BY wr.created_at ASC LIMIT 20`
    ),
  ]);
  return { deposits: depositRows.rows, withdrawals: withdrawalRows.rows };
}

// Summary numbers for the /stats command. "Active sessions" is a proxy for
// "online" — the schema has no last-seen heartbeat, only login token
// expiry, so this counts non-expired sessions rather than claiming a
// precise real-time online count.
export async function getStatsSummary() {
  const [txToday, pending, walletTotal, activeSessions] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE type = 'deposit') AS deposit_count,
         COALESCE(SUM(amount) FILTER (WHERE type = 'deposit'), 0) AS deposit_total,
         COUNT(*) FILTER (WHERE type = 'withdraw') AS withdrawal_count,
         COALESCE(SUM(amount) FILTER (WHERE type = 'withdraw'), 0) AS withdrawal_total
       FROM transactions
       WHERE created_at >= CURRENT_DATE`
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM deposit_requests WHERE status = 'pending') AS pending_deposits,
         (SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending') AS pending_withdrawals`
    ),
    pool.query(`SELECT COALESCE(SUM(balance), 0) AS total FROM wallets`),
    pool.query(`SELECT COUNT(*) AS count FROM sessions WHERE expires_at > NOW()`),
  ]);

  const t = txToday.rows[0];
  const p = pending.rows[0];

  return {
    depositCountToday: Number(t.deposit_count),
    depositTotalToday: Number(t.deposit_total),
    withdrawalCountToday: Number(t.withdrawal_count),
    withdrawalTotalToday: Number(t.withdrawal_total),
    pendingDeposits: Number(p.pending_deposits),
    pendingWithdrawals: Number(p.pending_withdrawals),
    internalBalance: Number(walletTotal.rows[0].total),
    activeSessions: Number(activeSessions.rows[0].count),
  };
}
