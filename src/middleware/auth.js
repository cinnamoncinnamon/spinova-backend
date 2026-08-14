import { verifyAccessToken } from "../services/jwtService.js";
import { isBanned } from "../services/banCheck.js";

// Attach this to any route that requires a logged-in user.
// Reads "Authorization: Bearer <token>", verifies it, and sets req.userId.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const token = header.slice("Bearer ".length);

  try {
    const payload = verifyAccessToken(token);

    // Checked on every request, not just at login — a ban takes effect
    // immediately instead of waiting out the token's remaining lifetime.
    if (await isBanned(payload.sub)) {
      return res.status(403).json({ error: "This account has been suspended." });
    }

    req.userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
