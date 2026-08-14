import jwt from "jsonwebtoken";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

const ACCESS_EXPIRY = "15m";
const REFRESH_EXPIRY_DAYS = 7;

// Short-lived token sent to the client and used on every API request
export function signAccessToken(userId) {
  return jwt.sign({ sub: userId }, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRY });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET); // throws if invalid/expired
}

// Long-lived token, stored in an httpOnly cookie. We only ever store a HASH
// of this in the DB (sessions.token_hash) -- never the raw token -- so that
// a stolen database dump alone can't be used to forge sessions.
export function generateRefreshToken() {
  return crypto.randomBytes(48).toString("hex");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function refreshExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_EXPIRY_DAYS);
  return d;
}

export const REFRESH_COOKIE_MAX_AGE_MS = REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
