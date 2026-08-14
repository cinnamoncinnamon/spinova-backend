// Shared event bus for the admin "live big-event feed". Any route or service
// (deposit approval, withdrawal creation, big win detection, etc.) can import
// this and call emitAdminEvent(...) — AdminFeedServer.js listens and pushes
// it out over WebSocket to any connected admin dashboards.
import { EventEmitter } from "events";

export const adminEvents = new EventEmitter();

/**
 * @param {string} type - e.g. "deposit", "withdraw", "big_win", "signup"
 * @param {object} payload - whatever the admin feed should display, e.g.
 *   { mobile, amount, game, userId }
 */
export function emitAdminEvent(type, payload) {
  adminEvents.emit("event", {
    type,
    ...payload,
    at: new Date().toISOString(),
  });
}
