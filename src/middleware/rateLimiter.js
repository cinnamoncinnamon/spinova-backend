import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis } from "../db/redis.js";

// IMPORTANT: each limiter needs its own Redis key prefix. rate-limit-redis
// defaults every RedisStore to the same "rl:" prefix, which means multiple
// limiters silently share one counter per IP instead of tracking
// independently — they'd interfere with each other, and express-rate-limit
// v7 throws ERR_ERL_DOUBLE_COUNT when two differently-configured limiters
// touch the same key within one request. Passing a unique `name` here keeps
// every limiter's counters fully separate in Redis.
function makeLimiter({ name, windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
    store: new RedisStore({
      prefix: `rl:${name}:`,
      sendCommand: (...args) => redis.call(...args),
    }),
  });
}

// 5 attempts / 5 min per IP - matches the master plan's security table
export const loginLimiter = makeLimiter({
  name: "login",
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: "Too many login attempts. Try again in a few minutes.",
});

// 3 attempts / 10 min per IP
export const registerLimiter = makeLimiter({
  name: "register",
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: "Too many registration attempts. Try again later.",
});

// 5 attempts / 5 min per IP — same shape as the player loginLimiter, but
// kept separate since admin login is a higher-value target.
export const adminLoginLimiter = makeLimiter({
  name: "admin-login",
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: "Too many login attempts. Try again in a few minutes.",
});

// 5 attempts / 15 min per IP — recovery codes are short, so this endpoint
// needs a tighter window than login to make brute-forcing impractical.
export const forgotPasswordLimiter = makeLimiter({
  name: "forgot-password",
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many reset attempts. Try again later.",
});

// 100 requests / min per IP, applied globally
export const globalLimiter = makeLimiter({
  name: "global",
  windowMs: 60 * 1000,
  max: 100,
  message: "Too many requests. Slow down.",
});