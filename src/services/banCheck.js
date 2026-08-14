import { pool } from "../db/pool.js";

// JWT access tokens are stateless and valid for 15 minutes — verifying the
// token alone only proves who the user is, not that they're still allowed
// to act. Without this check, banning someone only blocks their *next*
// login; anyone already holding a valid token keeps full access (betting,
// cashing out, deposits) until it naturally expires. This closes that gap
// by checking current ban status on every authenticated action, not just
// at login time.
export async function isBanned(userId) {
  try {
    const { rows } = await pool.query("SELECT is_banned FROM users WHERE id = $1", [userId]);
    if (!rows[0]) return true; // user no longer exists — treat as blocked, not as "not banned"
    return !!rows[0].is_banned;
  } catch (err) {
    console.error("Ban check failed:", err.message);
    return true; // fail closed — a DB hiccup should never silently grant a banned user access
  }
}
