import { pool } from "../db/pool.js";

// Backs the admin Games page's enable/disable toggle. Stored in the same
// game_controls table every other per-game admin setting uses, under a
// dedicated 'enabled' key at the game's top-level id (e.g. "wingo",
// "fxtrader") — separate from the per-mode/per-market rows used for
// forcing results (e.g. "wingo_30s", "fx_usdjpy"), so there's no collision.
export async function isGameEnabled(gameId) {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM game_controls WHERE game_id = $1 AND key = 'enabled'",
      [gameId]
    );
    // No row yet = never toggled = enabled by default, so a fresh install
    // isn't accidentally all-disabled.
    return rows[0] ? rows[0].value !== "false" : true;
  } catch {
    return true; // a settings-read hiccup shouldn't take every game down
  }
}

/** Global player-app switch. game_id="_app", key="online". Default true. */
export async function isAppOnline() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM game_controls WHERE game_id = $1 AND key = $2",
      ["_app", "online"]
    );
    return rows[0] ? rows[0].value !== "false" : true;
  } catch {
    return true;
  }
}

export async function setAppOnline(online) {
  const value = online ? "true" : "false";
  await pool.query(
    `INSERT INTO game_controls (game_id, key, value) VALUES ('_app', 'online', $1)
     ON CONFLICT (game_id, key) DO UPDATE SET value = $1`,
    [value]
  );
  return online;
}
