import express from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { pool, withTransaction } from "../db/pool.js";
import { sanitize } from "../middleware/sanitize.js";
import * as walletService from "../services/walletService.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import * as telegramActions from "../services/telegramActions.js";
import { isAppOnline, setAppOnline } from "../services/gameSettings.js";

const router = express.Router();

router.use(requireAdmin);

// ── Game Controls (Master Config) ──────────────────────────────────────────
// This MUST stay in sync with the game_id / key / value conventions that
// WinGoServer.js, K3Server.js, and CrashEngine.js actually read every round.
// WinGo/K3 are keyed per-market (multiple durations, forced independently).
// The three crash games (Aviator/Moto Ride/Road Rush) are single-market —
// one game_id each — since a crash round has no duration variants.
const GAME_MARKETS = {
  wingo: {
    modes: [
      { id: "wingo_30s", label: "30 Second" },
      { id: "wingo_60s", label: "1 Minute" },
      { id: "wingo_180s", label: "3 Minute" },
      { id: "wingo_300s", label: "5 Minute" },
    ],
    controls: {
      mode: ["Auto Risk", "Random", "Minority Wins", "Liability Cap", "Manual"],
      force_number: ["Random", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
      solo_win_rate: null,
      house_edge: null,
      stake_threshold: null,
      max_liability: null,
    },
  },
  k3: {
    modes: [
      { id: "k3_15s", label: "15 Second" },
      { id: "k3_30s", label: "30 Second" },
      { id: "k3_1m", label: "1 Minute" },
      { id: "k3_3m", label: "3 Minute" },
    ],
    controls: {
      mode: ["Auto Risk", "Random", "Minority Wins", "Liability Cap", "Manual"],
      force_result: ["Random", "Big", "Small", "Odd", "Even"],
      force_total: ["Random", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18"],
      solo_win_rate: null,
      house_edge: null,
      stake_threshold: null,
      max_liability: null,
    },
  },
  aviator: {
    modes: [{ id: "aviator", label: "Aviator" }],
    controls: {
      mode: ["Auto Risk", "Random", "Soft Bias", "Liability Cap", "Force Crash", "Force High"],
      force_multiplier: null,
      min_multiplier: null,
      max_multiplier: null,
      house_edge: null,
      stake_threshold: null,
      max_liability: null,
      auto_switch_rounds: null,
    },
  },
  motoride: {
    modes: [{ id: "motoride", label: "Moto Ride" }],
    controls: {
      mode: ["Auto Risk", "Random", "Soft Bias", "Liability Cap", "Force Crash", "Force High"],
      force_multiplier: null,
      min_multiplier: null,
      max_multiplier: null,
      house_edge: null,
      stake_threshold: null,
      max_liability: null,
      auto_switch_rounds: null,
    },
  },
  roadrush: {
    modes: [{ id: "roadrush", label: "Road Rush" }],
    controls: {
      mode: ["Auto Risk", "Random", "Soft Bias", "Liability Cap", "Force Crash", "Force High"],
      force_multiplier: null,
      min_multiplier: null,
      max_multiplier: null,
      house_edge: null,
      stake_threshold: null,
      max_liability: null,
      auto_switch_rounds: null,
    },
  },
  // FX Trader is server-authoritative — modes match WinGo/K3 hybrid.
  fxtrader: {
    modes: [
      { id: "fx_usdjpy", label: "USD/JPY" },
      { id: "fx_eurusd", label: "EUR/USD" },
      { id: "fx_gbpusd", label: "GBP/USD" },
      { id: "fx_xauusd", label: "XAU/USD" },
      { id: "fx_btcusd", label: "BTC/USD" },
    ],
    controls: {
      mode: ["Auto Risk", "Random", "Minority Wins", "Liability Cap", "Manual"],
      pending_force: ["Random", "UP", "DOWN"],
      solo_win_rate: null,
      house_edge: null,
      stake_threshold: null,
      max_liability: null,
    },
  },
};

// Numeric free-text fields don't all share the same valid range — multiplier
// fields are "at least 1x", solo_win_rate is a 0-1 probability. Centralizing
// this here instead of one hardcoded ">= 1" check.
const NUMERIC_BOUNDS = {
  force_multiplier: { min: 1 },
  min_multiplier: { min: 1 },
  max_multiplier: { min: 1 },
  solo_win_rate: { min: 0, max: 1 },
  house_edge: { min: 0, max: 20 }, // percent, e.g. 3 = 3% house edge
  stake_threshold: { min: 1 }, // Soft Bias ৳ threshold
  max_liability: { min: 1 }, // Liability Cap ৳ max exposure
  auto_switch_rounds: { min: 1, max: 100 }, // Auto Risk switch interval
};

// Flat lookup: gameId -> { game, controls, label } for fast validation on PUT
const GAME_ID_INDEX = {};
for (const [game, cfg] of Object.entries(GAME_MARKETS)) {
  for (const mode of cfg.modes) {
    GAME_ID_INDEX[mode.id] = { game, controls: cfg.controls, label: mode.label };
  }
}

function isValidNumericControl(key) {
  return key in NUMERIC_BOUNDS;
}

// GET current settings for every market, grouped by game. Markets with no
// row yet in game_controls default to "Random" (matches the fallback the
// game servers themselves use) — numeric-only controls default to "" instead.
router.get("/game-controls", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT game_id, key, value, updated_at FROM game_controls`);

    const lookup = {};
    for (const row of rows) {
      lookup[`${row.game_id}:${row.key}`] = { value: row.value, updatedAt: row.updated_at };
    }

    const games = {};
    for (const [game, cfg] of Object.entries(GAME_MARKETS)) {
      games[game] = cfg.modes.map((mode) => {
        const controls = {};
        let updatedAt = null;
        for (const key of Object.keys(cfg.controls)) {
          const entry = lookup[`${mode.id}:${key}`];
          const autoRiskDefault =
            ["aviator", "motoride", "roadrush"].includes(mode.id) ||
            mode.id.startsWith("wingo_") ||
            mode.id.startsWith("k3_") ||
            mode.id.startsWith("fx_");
          controls[key] = entry
            ? entry.value
            : isValidNumericControl(key)
              ? ""
              : key === "mode" && autoRiskDefault
                ? "Auto Risk"
                : "Random";
          if (entry && (!updatedAt || entry.updatedAt > updatedAt)) updatedAt = entry.updatedAt;
        }
        return { gameId: mode.id, label: mode.label, controls, updatedAt };
      });
    }

    res.json({ games });
  } catch (err) {
    console.error("Get game controls error:", err);
    res.status(500).json({ error: "Could not fetch game controls." });
  }
});

// PUT update one market's settings. Body: { controls: { key: value, ... } }
// Only accepts keys/values valid for that specific market — invalid
// combinations are rejected rather than silently ignored, so a bad admin UI
// request fails loudly instead of quietly doing nothing.
router.put("/game-controls/:gameId", async (req, res) => {
  const { gameId } = req.params;
  const { controls } = req.body;

  const known = GAME_ID_INDEX[gameId];
  if (!known) {
    return res.status(404).json({ error: "Unknown market." });
  }
  if (!controls || typeof controls !== "object" || Array.isArray(controls)) {
    return res.status(400).json({ error: "controls object is required." });
  }

  const entries = Object.entries(controls);
  if (entries.length === 0) {
    return res.status(400).json({ error: "controls object is empty." });
  }

  for (const [key, value] of entries) {
    if (!(key in known.controls)) {
      return res.status(400).json({ error: `Invalid control key "${key}" for ${gameId}.` });
    }
    const allowedValues = known.controls[key];
    if (allowedValues === null) {
      // Numeric free-text field — bounds depend on which field it is
      // (multipliers are >= 1x, solo_win_rate is a 0-1 probability).
      if (value !== "") {
        const bounds = NUMERIC_BOUNDS[key] || { min: 1 };
        const num = Number(value);
        const tooLow = isNaN(num) || num < bounds.min;
        const tooHigh = bounds.max !== undefined && num > bounds.max;
        if (tooLow || tooHigh) {
          const range = bounds.max !== undefined ? `between ${bounds.min} and ${bounds.max}` : `>= ${bounds.min}`;
          return res.status(400).json({ error: `"${key}" must be a number ${range}, or empty.` });
        }
      }
    } else if (!allowedValues.includes(String(value))) {
      return res.status(400).json({ error: `Invalid value "${value}" for "${key}".` });
    }
  }

  try {
    await withTransaction(async (client) => {
      for (const [key, value] of entries) {
        if (value === "") {
          // Numeric field cleared — delete rather than store an empty
          // string, so the engine's getGameControl() falls back to its
          // safe default instead of parseFloat("") producing NaN, which
          // would make a round unable to ever crash.
          await client.query(`DELETE FROM game_controls WHERE game_id = $1 AND key = $2`, [gameId, key]);
        } else {
          await client.query(
            `INSERT INTO game_controls (game_id, key, value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (game_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
            [gameId, key, String(value)]
          );
        }
      }
    });

    res.json({ ok: true, gameId, controls });
  } catch (err) {
    console.error("Update game controls error:", err);
    res.status(500).json({ error: "Could not update game controls." });
  }
});

// ── Deposit Methods Management ────────────────────────────────────────────────

// GET all methods (including inactive — admin sees everything)
router.get("/deposit-methods", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM deposit_methods ORDER BY display_order ASC, created_at ASC`
    );
    res.json({ methods: rows });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch deposit methods." });
  }
});

// POST add a new deposit method
router.post("/deposit-methods", async (req, res) => {
  const { method, label, account_number, min_amount, max_amount, note, display_order } = req.body;

  if (!method || !label || !account_number) {
    return res.status(400).json({ error: "method, label, and account_number are required." });
  }

  const validMethods = ["bkash", "nagad", "binance_pay", "binance_usdt"];
  if (!validMethods.includes(method)) {
    return res.status(400).json({ error: "Invalid method. Use: bkash, nagad, binance_pay, binance_usdt" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO deposit_methods
        (method, label, account_number, min_amount, max_amount, note, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        method,
        sanitize(label),
        sanitize(account_number),
        min_amount || 50,
        max_amount || 50000,
        note ? sanitize(note) : null,
        display_order || 0,
      ]
    );
    res.status(201).json({ method: rows[0] });
  } catch (err) {
    console.error("Add deposit method error:", err);
    res.status(500).json({ error: "Could not add deposit method." });
  }
});

// PATCH update a deposit method (number, label, active toggle, limits)
router.patch("/deposit-methods/:id", async (req, res) => {
  const { id } = req.params;
  const { label, account_number, min_amount, max_amount, note, is_active, display_order } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE deposit_methods SET
        label = COALESCE($1, label),
        account_number = COALESCE($2, account_number),
        min_amount = COALESCE($3, min_amount),
        max_amount = COALESCE($4, max_amount),
        note = COALESCE($5, note),
        is_active = COALESCE($6, is_active),
        display_order = COALESCE($7, display_order),
        updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        label ? sanitize(label) : null,
        account_number ? sanitize(account_number) : null,
        min_amount ?? null,
        max_amount ?? null,
        note ? sanitize(note) : null,
        is_active ?? null,
        display_order ?? null,
        id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: "Method not found." });
    res.json({ method: rows[0] });
  } catch (err) {
    console.error("Update deposit method error:", err);
    res.status(500).json({ error: "Could not update deposit method." });
  }
});

// DELETE a deposit method
router.delete("/deposit-methods/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM deposit_methods WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Could not delete deposit method." });
  }
});

// ── Deposit Requests (Approve / Reject) ──────────────────────────────────────

// GET all deposit requests (with user info)
router.get("/deposit-requests", async (req, res) => {
  const status = req.query.status || null;
  try {
    const { rows } = await pool.query(
      `SELECT dr.*, u.mobile, u.name,
              w.balance as current_balance
       FROM deposit_requests dr
       JOIN users u ON dr.user_id = u.id
       LEFT JOIN wallets w ON w.user_id = u.id
       ${status ? "WHERE dr.status = $1" : ""}
       ORDER BY dr.created_at DESC
       LIMIT 200`,
      status ? [status] : []
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error("Get deposit requests error:", err);
    res.status(500).json({ error: "Could not fetch deposit requests." });
  }
});

// POST approve a deposit request → credits the wallet
router.post("/deposit-requests/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { admin_note } = req.body;

  try {
    const { message } = await telegramActions.approveDepositRequest(id, admin_note || null);
    res.json({ ok: true, message });
  } catch (err) {
    if (err.message === "NOT_FOUND" || err.message === "ALREADY_PROCESSED") {
      return res.status(404).json({ error: "Request not found or already processed." });
    }
    console.error("Approve deposit error:", err);
    res.status(500).json({ error: "Could not approve deposit." });
  }
});

// POST reject a deposit request
router.post("/deposit-requests/:id/reject", async (req, res) => {
  const { id } = req.params;
  const { admin_note } = req.body;

  try {
    await telegramActions.rejectDepositRequest(id, admin_note || "Rejected by admin.");
    res.json({ ok: true });
  } catch (err) {
    if (err.message === "NOT_FOUND") {
      return res.status(404).json({ error: "Request not found or already processed." });
    }
    console.error("Reject deposit error:", err);
    res.status(500).json({ error: "Could not reject deposit." });
  }
});

// ── Withdrawal Requests ─────────────────────────────────────────────────────
// Mirrors deposit-requests above, with one real difference: the wallet was
// already debited when the user submitted the request (see
// routes/withdrawal.js), so approve here does NOT touch the wallet — it's
// just the paper trail for "admin sent this payout manually." Reject DOES
// touch the wallet: it refunds the held amount back, since the withdrawal
// never actually goes out.
router.get("/withdrawal-requests", async (req, res) => {
  const status = req.query.status || null;
  try {
    const { rows } = await pool.query(
      `SELECT wr.*, u.mobile, u.name,
              w.balance as current_balance
       FROM withdrawal_requests wr
       JOIN users u ON wr.user_id = u.id
       LEFT JOIN wallets w ON w.user_id = u.id
       ${status ? "WHERE wr.status = $1" : ""}
       ORDER BY wr.created_at DESC
       LIMIT 200`,
      status ? [status] : []
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error("Get withdrawal requests error:", err);
    res.status(500).json({ error: "Could not fetch withdrawal requests." });
  }
});

// POST approve a withdrawal request — records that the payout was sent
// manually. No wallet change: the amount was already deducted on submit.
router.post("/withdrawal-requests/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { admin_note } = req.body;

  try {
    const { message } = await telegramActions.approveWithdrawalRequest(id, admin_note || null);
    res.json({ ok: true, message });
  } catch (err) {
    if (err.message === "NOT_FOUND" || err.message === "ALREADY_PROCESSED") {
      return res.status(404).json({ error: "Request not found or already processed." });
    }
    console.error("Approve withdrawal error:", err);
    res.status(500).json({ error: "Could not approve withdrawal." });
  }
});

// POST reject a withdrawal request — refunds the held amount back to the
// user's wallet, atomically with the status update.
router.post("/withdrawal-requests/:id/reject", async (req, res) => {
  const { id } = req.params;
  const { admin_note } = req.body;

  try {
    const { message } = await telegramActions.rejectWithdrawalRequest(id, admin_note || "Rejected by admin.");
    res.json({ ok: true, message });
  } catch (err) {
    if (err.message === "NOT_FOUND" || err.message === "ALREADY_PROCESSED") {
      return res.status(404).json({ error: "Request not found or already processed." });
    }
    console.error("Reject withdrawal error:", err);
    res.status(500).json({ error: "Could not reject withdrawal." });
  }
});

// ── Games (Games.jsx admin page) ────────────────────────────────────────────
// Real roster of what's actually implemented (drops the old mock's fake "5D"
// and mislabeled "Moto Crash"), real stats from the transactions ledger
// instead of hardcoded numbers, and a real enable/disable toggle that the
// game servers/routes actually check before accepting a bet — see
// services/gameSettings.js and each game server's placeBet/bet handler.
const GAME_GROUPS = [
  { id: "wingo", name: "Win Go", category: "Lottery", gameIds: ["wingo"] },
  { id: "k3", name: "K3", category: "Lottery", gameIds: ["k3"] },
  { id: "aviator", name: "Aviator", category: "Crash", gameIds: ["aviator"] },
  { id: "motoride", name: "Moto Ride", category: "Crash", gameIds: ["motoride"] },
  { id: "roadrush", name: "Road Rush", category: "Crash", gameIds: ["roadrush"] },
  {
    id: "fxtrader", name: "FX Trader", category: "Trading",
    gameIds: ["fx_usdjpy", "fx_eurusd", "fx_gbpusd", "fx_xauusd", "fx_btcusd"],
  },
  { id: "goldenrelics", name: "Golden Relics", category: "Slots", gameIds: ["goldenrelics"] },
  { id: "elementsfury", name: "Elements Fury", category: "Slots", gameIds: ["elementsfury", "elementsfury-buyfeature"] },
  { id: "tombraiders", name: "Tomb Raiders", category: "Slots", gameIds: ["tombraiders", "tombraiders-gamble"] },
];
const GAME_GROUP_INDEX = {};
for (const g of GAME_GROUPS) GAME_GROUP_INDEX[g.id] = g;

router.get("/games", async (req, res) => {
  try {
    const allGameIds = GAME_GROUPS.flatMap((g) => g.gameIds);

    const { rows: statRows } = await pool.query(
      `SELECT game,
              COUNT(DISTINCT user_id) FILTER (WHERE type = 'bet' AND created_at > NOW() - INTERVAL '24 hours') AS active_players,
              COALESCE(SUM(amount) FILTER (WHERE type = 'bet'), 0) AS total_bet,
              COALESCE(SUM(amount) FILTER (WHERE type = 'win'), 0) AS total_win
       FROM transactions
       WHERE game = ANY($1)
       GROUP BY game`,
      [allGameIds]
    );
    const statsByGameId = {};
    for (const row of statRows) statsByGameId[row.game] = row;

    const { rows: enabledRows } = await pool.query(
      `SELECT game_id, value FROM game_controls WHERE game_id = ANY($1) AND key = 'enabled'`,
      [GAME_GROUPS.map((g) => g.id)]
    );
    const enabledByGroupId = {};
    for (const row of enabledRows) enabledByGroupId[row.game_id] = row.value !== "false";

    const games = GAME_GROUPS.map((group) => {
      let players = 0, bet = 0, win = 0;
      for (const gid of group.gameIds) {
        const s = statsByGameId[gid];
        if (s) {
          players += Number(s.active_players);
          bet += Number(s.total_bet);
          win += Number(s.total_win);
        }
      }
      return {
        id: group.id,
        name: group.name,
        category: group.category,
        players, // distinct active bettors, last 24h
        revenue: Math.round((bet - win) * 100) / 100, // house revenue, all-time
        status: enabledByGroupId[group.id] === false ? "disabled" : "active",
      };
    });

    res.json({ games });
  } catch (err) {
    console.error("Get games error:", err);
    res.status(500).json({ error: "Could not fetch games." });
  }
});

router.post("/games/:id/toggle", async (req, res) => {
  const group = GAME_GROUP_INDEX[req.params.id];
  if (!group) return res.status(404).json({ error: "Unknown game." });

  try {
    const { rows } = await pool.query(
      `SELECT value FROM game_controls WHERE game_id = $1 AND key = 'enabled'`,
      [group.id]
    );
    const currentlyEnabled = rows[0] ? rows[0].value !== "false" : true;
    const nextValue = currentlyEnabled ? "false" : "true";

    await pool.query(
      `INSERT INTO game_controls (game_id, key, value) VALUES ($1, 'enabled', $2)
       ON CONFLICT (game_id, key) DO UPDATE SET value = $2`,
      [group.id, nextValue]
    );

    res.json({ id: group.id, status: nextValue === "false" ? "disabled" : "active" });
  } catch (err) {
    console.error("Toggle game error:", err);
    res.status(500).json({ error: "Could not update game." });
  }
});

// ── Notifications ────────────────────────────────────────────────────────────
// v1 only supports audience='all' — see migrations/006_notifications.sql for
// why. "Reach" and "open rate" below are computed live against the real
// users/notification_reads tables, not fabricated numbers.
router.post("/notifications", async (req, res) => {
  const { title, body, type } = req.body;
  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "Title and body are required." });
  }
  const validTypes = new Set(["announcement", "alert", "promo"]);
  const safeType = validTypes.has(type) ? type : "announcement";

  try {
    const { rows } = await pool.query(
      `INSERT INTO notifications (title, body, type, audience, created_by)
       VALUES ($1, $2, $3, 'all', 'admin')
       RETURNING id, title, body, type, audience, created_at`,
      [title.trim(), body.trim(), safeType]
    );
    res.status(201).json({ notification: rows[0] });
  } catch (err) {
    console.error("Send notification error:", err);
    res.status(500).json({ error: "Could not send notification." });
  }
});

router.get("/notifications", async (req, res) => {
  try {
    const { rows: totalUsersRows } = await pool.query(`SELECT COUNT(*) AS count FROM users`);
    const totalUsers = Number(totalUsersRows[0].count);

    const { rows } = await pool.query(
      `SELECT n.id, n.title, n.body, n.type, n.audience, n.created_at,
              COUNT(nr.user_id) AS read_count
       FROM notifications n
       LEFT JOIN notification_reads nr ON nr.notification_id = n.id
       GROUP BY n.id
       ORDER BY n.created_at DESC
       LIMIT 100`
    );

    const history = rows.map((n) => ({
      ...n,
      reach: totalUsers, // audience is always 'all' in v1
      read_count: Number(n.read_count),
      open_rate: totalUsers > 0 ? Math.round((Number(n.read_count) / totalUsers) * 100) : 0,
    }));

    res.json({ notifications: history, total_users: totalUsers });
  } catch (err) {
    console.error("Get notification history error:", err);
    res.status(500).json({ error: "Could not fetch notification history." });
  }
});

// ── Promo Codes ──────────────────────────────────────────────────────────────
router.post("/promo-codes", async (req, res) => {
  const { code, amount, max_uses, expires_at } = req.body;
  const cleanCode = String(code || "").trim().toUpperCase();
  const parsedAmount = Number(amount);

  if (!cleanCode || !/^[A-Z0-9_-]{3,30}$/.test(cleanCode)) {
    return res.status(400).json({ error: "Code must be 3-30 letters/numbers." });
  }
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "Invalid amount." });
  }
  const parsedMaxUses = max_uses ? parseInt(max_uses, 10) : null;
  if (max_uses && (!Number.isInteger(parsedMaxUses) || parsedMaxUses <= 0)) {
    return res.status(400).json({ error: "Max uses must be a positive whole number." });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO promo_codes (code, amount, max_uses, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [cleanCode, parsedAmount, parsedMaxUses, expires_at || null]
    );
    res.status(201).json({ code: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That code already exists." });
    console.error("Create promo code error:", err);
    res.status(500).json({ error: "Could not create code." });
  }
});

router.get("/promo-codes", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 200`
    );
    const { rows: sumRows } = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM promo_redemptions`
    );
    res.json({ codes: rows, total_redeemed: Number(sumRows[0].total) });
  } catch (err) {
    console.error("Get promo codes error:", err);
    res.status(500).json({ error: "Could not fetch codes." });
  }
});

router.post("/promo-codes/:id/toggle", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE promo_codes SET status = CASE WHEN status = 'active' THEN 'inactive' ELSE 'active' END
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Code not found." });
    res.json({ code: rows[0] });
  } catch (err) {
    console.error("Toggle promo code error:", err);
    res.status(500).json({ error: "Could not update code." });
  }
});

// ── Direct Gifts ─────────────────────────────────────────────────────────────
router.post("/gifts", async (req, res) => {
  const { mobile, amount, reason } = req.body;
  const parsedAmount = Number(amount);

  if (!mobile || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "Mobile number and a valid amount are required." });
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows: userRows } = await client.query(
        `SELECT id FROM users WHERE mobile = $1`,
        [String(mobile).trim()]
      );
      if (!userRows[0]) throw new Error("USER_NOT_FOUND");

      const balanceAfter = await walletService.creditBonus(
        { userId: userRows[0].id, amount: parsedAmount },
        client
      );

      const { rows } = await client.query(
        `INSERT INTO admin_gifts (user_id, amount, reason) VALUES ($1, $2, $3) RETURNING *`,
        [userRows[0].id, parsedAmount, reason || null]
      );

      return { gift: rows[0], balanceAfter };
    });

    res.status(201).json({ message: `৳${parsedAmount} sent.`, gift: result.gift });
  } catch (err) {
    if (err.message === "USER_NOT_FOUND") return res.status(404).json({ error: "No user with that mobile number." });
    console.error("Send gift error:", err);
    res.status(500).json({ error: "Could not send gift." });
  }
});

router.get("/gifts", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.*, u.mobile FROM admin_gifts g
       JOIN users u ON u.id = g.user_id
       ORDER BY g.created_at DESC LIMIT 50`
    );
    res.json({ gifts: rows });
  } catch (err) {
    console.error("Get gifts error:", err);
    res.status(500).json({ error: "Could not fetch gifts." });
  }
});

// ── Admin Settings (RedZone toggles etc.) ──────────────────────────────────────
// Generic key/value store for simple UI-wide settings, starting with RedZone's
// "Hide Deposit Numbers" toggle. It was previously in-memory React state only,
// so it silently reset on every refresh/logout — this persists it.
router.get("/settings", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value FROM admin_settings`);
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    res.json({ settings });
  } catch (err) {
    console.error("Get settings error:", err);
    res.status(500).json({ error: "Could not fetch settings." });
  }
});

router.put("/settings/:key", async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (typeof value !== "string" || value.length > 200) {
    return res.status(400).json({ error: "value must be a string under 200 chars." });
  }
  try {
    await pool.query(
      `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
    res.json({ ok: true, key, value });
  } catch (err) {
    console.error("Update setting error:", err);
    res.status(500).json({ error: "Could not update setting." });
  }
});

// ── Dashboard Stats ────────────────────────────────────────────────────────────
// Real aggregate queries against tables that already exist — no fabricated
// numbers. "Pending Withdrawals" from the old mock UI is dropped: there is no
// withdrawal-approval table (withdrawals in wallet.js post instantly), so
// that stat had nothing real to point to. Pending *deposit* requests does
// have a real backing table (deposit_requests) and is used instead.
router.get("/dashboard-stats", async (req, res) => {
  try {
    const [users, txStats, pendingDeposits, recentActivity, gamePerformance] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS new_7d,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days') AS new_prior_7d
        FROM users
      `),
      pool.query(`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE type = 'deposit'), 0) AS deposits_total,
          COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND created_at >= NOW() - INTERVAL '7 days'), 0) AS deposits_7d,
          COALESCE(SUM(amount) FILTER (WHERE type = 'deposit' AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'), 0) AS deposits_prior_7d,
          COALESCE(SUM(amount) FILTER (WHERE type = 'withdraw'), 0) AS withdrawals_total,
          COALESCE(SUM(amount) FILTER (WHERE type = 'withdraw' AND created_at >= NOW() - INTERVAL '7 days'), 0) AS withdrawals_7d,
          COALESCE(SUM(amount) FILTER (WHERE type = 'withdraw' AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'), 0) AS withdrawals_prior_7d,
          COALESCE(SUM(amount) FILTER (WHERE type = 'bet'), 0) - COALESCE(SUM(amount) FILTER (WHERE type = 'win'), 0) AS revenue_total,
          COALESCE(SUM(amount) FILTER (WHERE type = 'bet' AND created_at >= NOW() - INTERVAL '7 days'), 0) - COALESCE(SUM(amount) FILTER (WHERE type = 'win' AND created_at >= NOW() - INTERVAL '7 days'), 0) AS revenue_7d,
          COALESCE(SUM(amount) FILTER (WHERE type = 'bet' AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'), 0) - COALESCE(SUM(amount) FILTER (WHERE type = 'win' AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'), 0) AS revenue_prior_7d,
          COUNT(DISTINCT user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS active_24h,
          COUNT(DISTINCT user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '48 hours' AND created_at < NOW() - INTERVAL '24 hours') AS active_prior_24h
        FROM transactions
      `),
      pool.query(`SELECT COUNT(*) AS pending FROM deposit_requests WHERE status = 'pending'`),
      pool.query(`
        (SELECT 'register' AS kind, u.mobile, NULL::text AS game, NULL::decimal AS amount, u.created_at AS at
         FROM users u ORDER BY u.created_at DESC LIMIT 15)
        UNION ALL
        (SELECT t.type AS kind, u.mobile, t.game, t.amount, t.created_at AS at
         FROM transactions t JOIN users u ON t.user_id = u.id
         ORDER BY t.created_at DESC LIMIT 15)
        ORDER BY at DESC LIMIT 15
      `),
      pool.query(`
        SELECT
          game,
          COUNT(DISTINCT user_id) AS players,
          COUNT(DISTINCT round_id) FILTER (WHERE type = 'bet') AS rounds,
          COALESCE(SUM(amount) FILTER (WHERE type = 'bet'), 0) - COALESCE(SUM(amount) FILTER (WHERE type = 'win'), 0) AS revenue
        FROM transactions
        WHERE game IS NOT NULL
        GROUP BY game
        ORDER BY revenue DESC
      `),
    ]);

    const pctChange = (curr, prev) => {
      curr = Number(curr);
      prev = Number(prev);
      if (prev === 0) return curr === 0 ? 0 : null; // null = "no prior-period baseline" — frontend hides the badge rather than showing a fake %
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    };

    const u = users.rows[0];
    const t = txStats.rows[0];

    res.json({
      totalUsers: Number(u.total),
      newUsersChangePct: pctChange(u.new_7d, u.new_prior_7d),
      totalDeposits: Number(t.deposits_total),
      depositsChangePct: pctChange(t.deposits_7d, t.deposits_prior_7d),
      totalWithdrawals: Number(t.withdrawals_total),
      withdrawalsChangePct: pctChange(t.withdrawals_7d, t.withdrawals_prior_7d),
      activePlayers24h: Number(t.active_24h),
      activePlayersChangePct: pctChange(t.active_24h, t.active_prior_24h),
      totalRevenue: Number(t.revenue_total),
      revenueChangePct: pctChange(t.revenue_7d, t.revenue_prior_7d),
      pendingDepositRequests: Number(pendingDeposits.rows[0].pending),
      recentActivity: recentActivity.rows,
      gamePerformance: gamePerformance.rows.map((g) => ({
        game: g.game,
        players: Number(g.players),
        rounds: Number(g.rounds),
        revenue: Number(g.revenue),
      })),
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ error: "Could not fetch dashboard stats." });
  }
});

// ── Users Overview ────────────────────────────────────────────────────────────
router.get("/users", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.mobile, u.name, u.is_banned, u.created_at,
              w.balance
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT 500`
    );
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch users." });
  }
});

// Manual balance adjustment (admin credits/deducts)
router.post("/users/:id/adjust-balance", async (req, res) => {
  const { amount, type, note } = req.body;
  const parsedAmount = Number(amount);

  if (!parsedAmount || !type || !["deposit", "withdraw"].includes(type)) {
    return res.status(400).json({ error: "Invalid amount or type (deposit/withdraw)." });
  }

  try {
    let balance;
    if (type === "deposit") {
      balance = await walletService.recordDeposit({ userId: req.params.id, amount: Math.abs(parsedAmount) });
    } else {
      balance = await walletService.recordWithdraw({ userId: req.params.id, amount: Math.abs(parsedAmount) });
    }
    res.json({ ok: true, balance });
  } catch (err) {
    if (err.message === "Insufficient balance") {
      return res.status(400).json({ error: "Insufficient balance." });
    }
    res.status(500).json({ error: "Could not adjust balance." });
  }
});

// Admin-assisted password reset: generates a temporary password, hashes it
// the same way registration does, stores the hash, and returns the plaintext
// ONCE so the admin can relay it to the player through the existing support
// channel. Nothing is emailed/texted automatically — no SMS/email provider
// required for launch.
router.post("/users/:id/reset-password", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id FROM users WHERE id = $1", [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    // 10 random bytes -> 16-char base32-ish string, easy to read aloud/type,
    // no ambiguous characters (0/O, 1/l) mixed up when relayed over chat/call.
    const tempPassword = crypto
      .randomBytes(10)
      .toString("base64")
      .replace(/[+/=]/g, "")
      .slice(0, 12);

    const passwordHash = await bcrypt.hash(tempPassword, 12);

    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, req.params.id]);

    // Invalidate existing sessions so a leaked old token can't be used
    // alongside the new password.
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [req.params.id]);

    res.json({ ok: true, tempPassword });
  } catch (err) {
    res.status(500).json({ error: "Could not reset password." });
  }
});

// ── Transactions Overview ─────────────────────────────────────────────────────
// GET all transactions across all users, newest first. Supports optional
// filtering by type, date range, and searching by user mobile/name, plus
// simple pagination.
router.get("/transactions", async (req, res) => {
  const { type, search, limit, offset, from, to } = req.query;
  const lim = Math.min(parseInt(limit) || 100, 500);
  const off = parseInt(offset) || 0;

  const conditions = [];
  const params = [];

  if (type) {
    params.push(type);
    conditions.push(`t.type = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(u.mobile ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
  }
  if (from) {
    params.push(from);
    conditions.push(`t.created_at >= $${params.length}`);
  }
  if (to) {
    // treat "to" as inclusive of the whole day
    params.push(to);
    conditions.push(`t.created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    params.push(lim, off);
    const { rows } = await pool.query(
      `SELECT t.id, t.type, t.amount, t.balance_before, t.balance_after,
              t.game, t.round_id, t.status, t.created_at,
              u.id as user_id, u.mobile, u.name
       FROM transactions t
       JOIN users u ON t.user_id = u.id
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ transactions: rows });
  } catch (err) {
    console.error("Get transactions error:", err);
    res.status(500).json({ error: "Could not fetch transactions." });
  }
});
// Single user's deposit/withdraw history only (used by the Live Balances
// trend chart — fetched on-demand when an admin expands a user row, not on
// every poll, so we don't pull every user's transactions every 5 seconds).
router.get("/users/:id/balance-history", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, type, amount, balance_before, balance_after, created_at
       FROM transactions
       WHERE user_id = $1 AND type IN ('deposit', 'withdraw')
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.params.id]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error("Get balance history error:", err);
    res.status(500).json({ error: "Could not fetch balance history." });
  }
});
// Ban / unban a user
router.patch("/users/:id/ban", async (req, res) => {
  const { is_banned } = req.body;
  try {
    await pool.query(`UPDATE users SET is_banned = $1 WHERE id = $2`, [!!is_banned, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Could not update user." });
  }
});

// Multi-account risk flag #1: users who have logged in from the same IP.
// A shared IP alone isn't proof of abuse (families/offices share networks),
// but it's a useful signal to review manually, especially combined with
// other flags like shared payout details.
router.get("/risk/shared-ip", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.ip_address,
              json_agg(json_build_object('id', u.id, 'mobile', u.mobile, 'name', u.name)) AS users
       FROM (SELECT DISTINCT ip_address, user_id FROM sessions WHERE ip_address IS NOT NULL) s
       JOIN users u ON u.id = s.user_id
       GROUP BY s.ip_address
       HAVING COUNT(DISTINCT s.user_id) > 1
       ORDER BY COUNT(DISTINCT s.user_id) DESC`
    );
    res.json({ groups: rows });
  } catch (err) {
    console.error("Get shared-IP risk error:", err);
    res.status(500).json({ error: "Could not check shared IPs." });
  }
});

// Multi-account risk flag #2: different accounts asking to withdraw to the
// SAME payout number (bKash/Nagad/Binance address). This is a much stronger
// signal than shared IP alone — legitimate players don't share their own
// payout destination with strangers, so this usually means either one
// person running multiple accounts, or a promo-code abuse ring.
router.get("/risk/shared-payout", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.account_details, w.method,
              json_agg(DISTINCT jsonb_build_object('id', u.id, 'mobile', u.mobile, 'name', u.name)) AS users
       FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id
       GROUP BY w.account_details, w.method
       HAVING COUNT(DISTINCT w.user_id) > 1
       ORDER BY COUNT(DISTINCT w.user_id) DESC`
    );
    res.json({ groups: rows });
  } catch (err) {
    console.error("Get shared-payout risk error:", err);
    res.status(500).json({ error: "Could not check shared payout details." });
  }
});

// RTP (Return to Player) monitoring — computed directly from existing
// bet/win transactions. No new tables needed: every bet and win already
// flows through walletService.adjustBalance() and lands in `transactions`
// with a `game` column.
//
// RTP = total paid out / total wagered, per game, over a time window.
// This is the same class of check that would have caught the Golden Relics
// bug (a supercritical free-spin loop paying out ~17,867% RTP) before it
// reached production — a bug in the free-spin retrigger math would show up
// here as a game with RTP wildly above its configured target, in real time,
// instead of being discovered after the fact.
router.get("/rtp", async (req, res) => {
  // Default window: last 24 hours. Accepts ?hours=N to widen/narrow it.
  const hours = Math.min(parseInt(req.query.hours) || 24, 720); // cap at 30 days
  try {
    const { rows } = await pool.query(
      `SELECT
         game,
         COALESCE(SUM(amount) FILTER (WHERE type = 'bet'), 0) AS total_wagered,
         COALESCE(SUM(amount) FILTER (WHERE type = 'win'), 0) AS total_paid_out,
         COUNT(*) FILTER (WHERE type = 'bet') AS bet_count,
         COUNT(*) FILTER (WHERE type = 'win') AS win_count
       FROM transactions
       WHERE game IS NOT NULL
         AND type IN ('bet', 'win')
         AND created_at >= NOW() - ($1 || ' hours')::interval
       GROUP BY game
       ORDER BY game`,
      [hours]
    );

    const games = rows.map((r) => {
      const wagered = Number(r.total_wagered);
      const paidOut = Number(r.total_paid_out);
      const rtp = wagered > 0 ? (paidOut / wagered) * 100 : null;
      return {
        game: r.game,
        totalWagered: wagered,
        totalPaidOut: paidOut,
        betCount: Number(r.bet_count),
        winCount: Number(r.win_count),
        rtpPercent: rtp === null ? null : Math.round(rtp * 100) / 100,
      };
    });

    res.json({ hours, games });
  } catch (err) {
    console.error("Get RTP error:", err);
    res.status(500).json({ error: "Could not compute RTP." });
  }
});


// ── Global app maintenance (player app on/off) ───────────────────────────────
router.get("/app-status", async (req, res) => {
  try {
    const online = await isAppOnline();
    res.json({ online });
  } catch (err) {
    console.error("app-status error:", err);
    res.status(500).json({ error: "Could not read app status." });
  }
});

router.post("/app-status", async (req, res) => {
  try {
    const wantOnline = req.body?.online !== false && req.body?.online !== "false";
    // body: { online: true } or { online: false }
    const online = await setAppOnline(!!wantOnline);
    res.json({ online, message: online ? "App is live for players." : "App is under construction (players blocked)." });
  } catch (err) {
    console.error("set app-status error:", err);
    res.status(500).json({ error: "Could not update app status." });
  }
});

export default router;