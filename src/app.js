import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

import authRoutes from "./routes/auth.js";
import walletRoutes from "./routes/wallet.js";
import depositRoutes from "./routes/deposit.js";
import withdrawalRoutes from "./routes/withdrawal.js";
import notificationsRoutes from "./routes/notifications.js";
import promoRoutes from "./routes/promo.js";
import adminAuthRoutes from "./routes/adminAuth.js";
import adminRoutes from "./routes/admin.js";
import slotsRoutes from "./routes/slots.js";
import plinkoRoutes from "./routes/plinko.js";
import { globalLimiter } from "./middleware/rateLimiter.js";
import { startTelegramBot } from "./services/telegramBot.js";
import { isAppOnline } from "./services/gameSettings.js";
dotenv.config();

const app = express();
app.set("trust proxy", 1);
app.use(
  cors({
    origin: [process.env.CORS_ORIGIN_1, process.env.CORS_ORIGIN_2],
    credentials: true, // required so the httpOnly refresh cookie is sent
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(globalLimiter);

app.get("/health", (req, res) => res.json({ ok: true }));

// Public: player app checks this before login (no auth required)
app.get("/api/status", async (req, res) => {
  try {
    const online = await isAppOnline();
    res.json({
      online,
      message: online
        ? "ok"
        : "App is under construction. Please check back soon.",
    });
  } catch {
    res.json({ online: true, message: "ok" });
  }
});


app.use("/api/auth", authRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/withdrawal", withdrawalRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/promo", promoRoutes);
// Login is public (no requireAdmin) — mounted first so it's matched before
// the protected admin router below. Everything else under /api/admin
// requires a real, verified admin session token.
app.use("/api/admin", adminAuthRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/games/slots", slotsRoutes);
app.use("/api/plinko", plinkoRoutes);

// Never leak stack traces or internals to the client (master plan: "never
// expose internals"). Logs the real error server-side only.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong." });
});

import { createServer } from "http";
import { createWinGoServer } from "./games/WinGoServer.js";
import { createK3Server } from "./games/K3Server.js";
import { createCrashServer } from "./games/CrashEngine.js";
import { createFxTraderServer } from "./games/FXTraderServer.js";

const PORT = process.env.PORT || 4000;
const httpServer = createServer(app);

// Attach WebSocket game servers via manual upgrade routing. Each
// WebSocketServer is created with `noServer: true` so it doesn't grab every
// incoming connection on the httpServer — without this, whichever game
// server attaches first ends up rejecting every other game's handshake with
// 400 Bad Request before it ever reaches the intended server.
const winGoWss = createWinGoServer();
const k3Wss = createK3Server();
const aviatorWss = createCrashServer("aviator");
const motorideWss = createCrashServer("motoride");
const roadrushWss = createCrashServer("roadrush");
const fxTraderWss = createFxTraderServer();

const WS_SERVERS = {
  "/ws/wingo": winGoWss,
  "/ws/k3": k3Wss,
  "/ws/aviator": aviatorWss,
  "/ws/motoride": motorideWss,
  "/ws/roadrush": roadrushWss,
  "/ws/fxtrader": fxTraderWss,
};

httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const wss = WS_SERVERS[pathname];
  if (wss) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

startTelegramBot();
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`SPINOVA backend running on port ${PORT}`);
});