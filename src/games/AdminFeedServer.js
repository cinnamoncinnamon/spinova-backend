import { WebSocketServer } from "ws";
import { adminEvents } from "../services/adminEvents.js";

// Read-only feed for the admin dashboard — connected clients receive every
// event pushed via emitAdminEvent(), they never send anything meaningful back.
export function createAdminFeedServer() {
  const wss = new WebSocketServer({ noServer: true });

  const broadcast = (event) => {
    const msg = JSON.stringify(event);
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(msg);
    });
  };

  adminEvents.on("event", broadcast);

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "connected", at: new Date().toISOString() }));
  });

  return wss;
}
