import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { adminLoginLimiter } from "../middleware/rateLimiter.js";

const router = express.Router();

router.post("/login", adminLoginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  // Constant-shape response whether the username or password was wrong —
  // never reveal which one was incorrect.
  if (username !== process.env.ADMIN_USERNAME) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const hash = process.env.ADMIN_PASSWORD_HASH;

  if (!hash) {
    console.error("ADMIN_PASSWORD_HASH is not set in .env — admin login is disabled.");
    return res.status(500).json({ error: "Admin login is not configured." });
  }

  const match = await bcrypt.compare(password, hash);
  if (!match) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

const accessToken = jwt.sign(
  { role: "admin", username },
  process.env.ADMIN_JWT_SECRET,
  { expiresIn: "8h" }
);
  res.json({ accessToken, expiresIn: "8h" });
});

export default router;