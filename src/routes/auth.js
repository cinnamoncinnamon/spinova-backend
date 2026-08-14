import express from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { pool, withTransaction } from "../db/pool.js";
import { redis } from "../db/redis.js";
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  refreshExpiryDate,
  REFRESH_COOKIE_MAX_AGE_MS,
} from "../services/jwtService.js";
import { validateRegisterInput, validateLoginInput, validateForgotPasswordInput } from "../middleware/sanitize.js";
import { loginLimiter, registerLimiter, forgotPasswordLimiter } from "../middleware/rateLimiter.js";
import { requireAuth } from "../middleware/auth.js";
import { isAppOnline } from "../services/gameSettings.js";

const router = express.Router();

const REFRESH_COOKIE_NAME = "spinova_refresh";
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: REFRESH_COOKIE_MAX_AGE_MS,
};

// Extra protection on top of the per-IP loginLimiter: block by mobile number
// too, so an attacker rotating IPs still can't brute-force one specific account.
async function checkPerMobileLoginAttempts(mobile) {
  const key = `login_attempts:${mobile}`;
  const attempts = await redis.incr(key);
  if (attempts === 1) await redis.expire(key, 5 * 60); // 5 min window
  if (attempts > 5) {
    throw Object.assign(new Error("Too many login attempts for this account. Try again later."), {
      status: 429,
    });
  }
}

async function clearPerMobileLoginAttempts(mobile) {
  await redis.del(`login_attempts:${mobile}`);
}

// Same brute-force protection as login, but its own counter/key — a recovery
// code is short, so this needs to be locked down at least as tightly.
async function checkPerMobileResetAttempts(mobile) {
  const key = `reset_attempts:${mobile}`;
  const attempts = await redis.incr(key);
  if (attempts === 1) await redis.expire(key, 15 * 60);
  if (attempts > 5) {
    throw Object.assign(new Error("Too many reset attempts for this account. Try again later."), {
      status: 429,
    });
  }
}

async function clearPerMobileResetAttempts(mobile) {
  await redis.del(`reset_attempts:${mobile}`);
}

// 12 characters, unambiguous alphabet (no 0/O/1/I/L) so it's easy to read
// back and type correctly. Displayed to the user as XXXX-XXXX-XXXX.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateRecoveryCode() {
  let code = "";
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) {
    code += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  return code;
}
function formatRecoveryCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

router.post("/register", registerLimiter, async (req, res) => {
  const check = validateRegisterInput(req.body);
  if (!check.ok) return res.status(400).json({ error: check.message });

  if (!(await isAppOnline())) {
    return res.status(503).json({
      error: "App is under construction. Please check back soon.",
      maintenance: true,
    });
  }

  const { mobile, name } = check;
  const { password } = req.body;

  try {
    const existing = await pool.query("SELECT id FROM users WHERE mobile = $1", [mobile]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with this mobile number already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await bcrypt.hash(recoveryCode, 12);

    const userId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (mobile, name, password_hash, recovery_code_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
        [mobile, name || null, passwordHash, recoveryCodeHash]
      );
      const newUserId = rows[0].id;

      // Every new account starts with a wallet, balance 0 — server-owned from day one.
      await client.query(`INSERT INTO wallets (user_id, balance) VALUES ($1, 0.00)`, [newUserId]);

      return newUserId;
    });

    const { accessToken, refreshToken } = await issueSession(userId, req);
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, cookieOptions);
    // recoveryCode is returned ONCE, here — it's never stored in plaintext
    // and there's no way to retrieve it again later, only rotate it via reset.
    res.status(201).json({
      accessToken,
      user: { id: userId, mobile, name },
      recoveryCode: formatRecoveryCode(recoveryCode),
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  const check = validateLoginInput(req.body);
  if (!check.ok) return res.status(400).json({ error: check.message });

  if (!(await isAppOnline())) {
    return res.status(503).json({
      error: "App is under construction. Please check back soon.",
      maintenance: true,
    });
  }

  const { mobile } = check;
  const { password } = req.body;

  try {
    await checkPerMobileLoginAttempts(mobile);

    const { rows } = await pool.query(
      "SELECT id, mobile, name, password_hash, is_banned FROM users WHERE mobile = $1",
      [mobile]
    );
    const user = rows[0];

    // Same generic error whether the mobile doesn't exist or the password is
    // wrong - never reveal which one it was, that's a user-enumeration leak.
    const genericError = () => res.status(401).json({ error: "Invalid mobile number or password." });

    if (!user) return genericError();

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) return genericError();

    if (user.is_banned) {
      return res.status(403).json({ error: "This account has been suspended." });
    }

    await clearPerMobileLoginAttempts(mobile);

    const { accessToken, refreshToken } = await issueSession(user.id, req);
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, cookieOptions);
    res.json({ accessToken, user: { id: user.id, mobile: user.mobile, name: user.name } });
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: err.message });
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  const check = validateForgotPasswordInput(req.body);
  if (!check.ok) return res.status(400).json({ error: check.message });

  const { mobile, recoveryCode } = check;
  const { newPassword } = req.body;

  // Same generic error for "no such account" and "wrong code" — never
  // reveal which one it was, that's a user-enumeration leak.
  const genericError = () => res.status(400).json({ error: "Invalid mobile number or recovery code." });

  try {
    await checkPerMobileResetAttempts(mobile);

    const { rows } = await pool.query(
      "SELECT id, recovery_code_hash FROM users WHERE mobile = $1",
      [mobile]
    );
    const user = rows[0];

    if (!user || !user.recovery_code_hash) return genericError();

    const codeMatches = await bcrypt.compare(recoveryCode, user.recovery_code_hash);
    if (!codeMatches) return genericError();

    await clearPerMobileResetAttempts(mobile);

    const newPasswordHash = await bcrypt.hash(newPassword, 12);
    // Rotate the recovery code too — it's one-time. The old code stops
    // working the moment this succeeds, and a fresh one is issued below.
    const newRecoveryCode = generateRecoveryCode();
    const newRecoveryCodeHash = await bcrypt.hash(newRecoveryCode, 12);

    await pool.query(
      "UPDATE users SET password_hash = $1, recovery_code_hash = $2 WHERE id = $3",
      [newPasswordHash, newRecoveryCodeHash, user.id]
    );

    // Log out every existing session — a leaked old access/refresh token
    // shouldn't survive a password reset.
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);

    res.json({ ok: true, recoveryCode: formatRecoveryCode(newRecoveryCode) });
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: err.message });
    console.error("Forgot-password error:", err);
    res.status(500).json({ error: "Could not reset password. Please try again." });
  }
});

router.post("/refresh", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const tokenHash = hashToken(token);
    const { rows } = await pool.query(
      "SELECT id, user_id, expires_at FROM sessions WHERE token_hash = $1",
      [tokenHash]
    );
    const session = rows[0];

    if (!session || new Date(session.expires_at) < new Date()) {
      res.clearCookie(REFRESH_COOKIE_NAME);
      return res.status(401).json({ error: "Session expired, please log in again." });
    }

    // Rotate: invalidate the old refresh token immediately, issue a new one.
    await pool.query("DELETE FROM sessions WHERE id = $1", [session.id]);

    const { accessToken, refreshToken } = await issueSession(session.user_id, req);
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, cookieOptions);
    res.json({ accessToken });
  } catch (err) {
    console.error("Refresh error:", err);
    res.status(500).json({ error: "Could not refresh session." });
  }
});

router.post("/logout", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (token) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  }
  res.clearCookie(REFRESH_COOKIE_NAME);
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, mobile, name FROM users WHERE id = $1",
    [req.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: "User not found" });
  res.json({ user: rows[0] });
});

// Shared by register/login/refresh: creates a DB session row + signs both tokens
async function issueSession(userId, req) {
  const accessToken = signAccessToken(userId);
  const refreshToken = generateRefreshToken();

  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, device_fingerprint, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(refreshToken), req.headers["user-agent"] || null, req.ip || null, refreshExpiryDate()]
  );

  return { accessToken, refreshToken };
}

export default router;
