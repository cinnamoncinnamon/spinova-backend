import dns from "dns";
import TelegramBot from "node-telegram-bot-api";
import { adminEvents } from "./adminEvents.js";
import * as telegramActions from "./telegramActions.js";

// This machine's IPv6 route is broken (connections time out), while IPv4
// connects fine — confirmed via `curl -4`. dns.setDefaultResultOrder only
// reorders candidates and isn't strict enough, so we force every dns.lookup
// in this process to resolve IPv4-only instead.
const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  return originalLookup(hostname, { ...options, family: 4 }, callback);
};

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

const TYPE_LABELS = {
  deposit: "📥 Deposit approved",
  withdraw: "📤 Withdrawal held",
  big_win: "🏆 Big Win",
};

let bot = null;

// In-memory "did they already tap once" tracker for the confirm-before-action
// flow. Keyed by callback_data ("approve:deposit:42"), cleared automatically
// after CONFIRM_WINDOW_MS so a stale confirm can't fire hours later.
const pendingConfirms = new Map();
const CONFIRM_WINDOW_MS = 30_000;

function isAdmin(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

export function startTelegramBot() {
  if (!TOKEN || !ADMIN_CHAT_ID) {
    console.warn("Telegram bot not started — TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID missing from .env");
    return;
  }

  try {
    bot = new TelegramBot(TOKEN, {
      polling: {
        interval: 2000,
        autoStart: true,
        params: { timeout: 10 },
      },
    });
  } catch (err) {
    console.error("Telegram bot failed to initialize — alerts disabled, backend continues:", err.message);
    return;
  }

  bot.setMyCommands([
    { command: "start", description: "Show welcome message" },
    { command: "pending", description: "List pending deposit & withdrawal requests" },
    { command: "stats", description: "Today's deposits, withdrawals, balance & pending" },
  ]).catch((err) => console.error("Telegram setMyCommands error:", err.message));

  bot.on("polling_error", (err) => {
    console.error(`Telegram polling error [${err.code || "unknown"}]:`, err.message);
  });

  bot.on("error", (err) => {
    console.error("Telegram bot general error:", err.message);
  });

  // ── Commands ────────────────────────────────────────────────────────────
  bot.on("message", async (msg) => {
    if (!isAdmin(msg.chat.id)) {
      return bot.sendMessage(msg.chat.id, "Access Denied.").catch(() => {});
    }
    const text = (msg.text || "").trim();

    if (text === "/start") {
      return safeSend(
        "SPINOVA admin alerts are live. You'll get pinged here for new deposit/withdrawal requests and big wins.\n\nCommands:\n/pending — list pending deposit & withdrawal requests\n/stats — today's totals, balance & pending counts"
      );
    }

    if (text === "/stats") {
      try {
        const s = await telegramActions.getStatsSummary();
        const lines = [
          "📊 SPINOVA STATS",
          `Today: ${s.depositCountToday} deposits (৳${s.depositTotalToday.toLocaleString()}), ${s.withdrawalCountToday} withdrawals (৳${s.withdrawalTotalToday.toLocaleString()})`,
          `Pending: ${s.pendingDeposits} deposits, ${s.pendingWithdrawals} withdrawals`,
          `Internal balance (total user funds held): ৳${s.internalBalance.toLocaleString()}`,
          `Active sessions: ${s.activeSessions}`,
        ];
        return safeSend(lines.join("\n"));
      } catch (err) {
        console.error("Telegram /stats error:", err.message);
        return safeSend("Couldn't fetch stats — check server logs.");
      }
    }

    if (text === "/pending") {
      try {
        const { deposits, withdrawals } = await telegramActions.getPendingSummary();

        if (deposits.length === 0 && withdrawals.length === 0) {
          return safeSend("No pending requests right now. ✅");
        }

        for (const d of deposits) {
          await sendDepositRequestCard({
            requestId: d.id,
            mobile: d.mobile,
            amount: d.amount,
            method: d.method,
            depositNumber: d.account_number,
            transactionId: d.transaction_id,
          });
        }
        for (const w of withdrawals) {
          await sendWithdrawalRequestCard({
            requestId: w.id,
            mobile: w.mobile,
            amount: w.amount,
            method: w.method,
            accountDetails: w.account_details,
          });
        }
      } catch (err) {
        console.error("Telegram /pending error:", err.message);
        safeSend("Couldn't fetch pending requests — check server logs.");
      }
      return;
    }

    // Anything else typed that isn't a recognized command
    return safeSend("Unrecognized command.\n\nAvailable commands:\n/start — show welcome message\n/pending — list pending deposit & withdrawal requests\n/stats — today's totals, balance & pending counts");
  });

  // ── Inline button taps (Approve/Reject) ────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!isAdmin(query.message.chat.id)) {
      return bot.answerCallbackQuery(query.id, { text: "Access Denied." });
    }

    const [action, kind, id] = query.data.split(":"); // e.g. "approve:deposit:42"
    const validCombo =
      (kind === "deposit" || kind === "withdrawal") && (action === "approve" || action === "reject");
    if (!validCombo) {
      return bot.answerCallbackQuery(query.id, { text: "Unknown action." });
    }

    // First tap: arm the confirmation, change the buttons to a confirm
    // prompt, don't touch the database yet. On timeout, revert the buttons
    // back to normal AND tell you it expired — no silent state changes.
    if (!pendingConfirms.has(query.data)) {
      const timeoutId = setTimeout(async () => {
        pendingConfirms.delete(query.data);
        const normalKeyboard = {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `approve:${kind}:${id}` },
              { text: "❌ Reject", callback_data: `reject:${kind}:${id}` },
            ],
          ],
        };
        await bot.editMessageReplyMarkup(normalKeyboard, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }).catch((err) => console.error("Telegram revert-on-timeout error:", err.message));
        await bot.sendMessage(
          query.message.chat.id,
          `⏱ Confirmation for ${kind} #${id} expired — tap Approve/Reject again if you still want to act on it.`
        ).catch((err) => console.error("Telegram timeout-notice error:", err.message));
      }, CONFIRM_WINDOW_MS);

      pendingConfirms.set(query.data, timeoutId);

      const confirmLabel = action === "approve" ? "✅ Tap again to CONFIRM approve" : "❌ Tap again to CONFIRM reject";
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: confirmLabel, callback_data: query.data }]] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      ).catch((err) => console.error("Telegram editMessageReplyMarkup error:", err.message));

      return bot.answerCallbackQuery(query.id, { text: "Tap once more within 30s to confirm." });
    }

    // Second tap within the window: actually execute.
    clearTimeout(pendingConfirms.get(query.data));
    pendingConfirms.delete(query.data);

    try {
      let result;
      if (kind === "deposit" && action === "approve") {
        result = await telegramActions.approveDepositRequest(id);
      } else if (kind === "deposit" && action === "reject") {
        result = await telegramActions.rejectDepositRequest(id);
      } else if (kind === "withdrawal" && action === "approve") {
        result = await telegramActions.approveWithdrawalRequest(id);
      } else {
        result = await telegramActions.rejectWithdrawalRequest(id);
      }

      await bot.answerCallbackQuery(query.id, { text: result.message });

      // Edit the original card: drop the buttons, append the outcome so the
      // chat log stays a clean audit trail of what was approved/rejected.
      const outcomeLine = `\n\n${action === "approve" ? "✅ APPROVED" : "❌ REJECTED"} — ${result.message}`;
      await bot.editMessageText(query.message.text + outcomeLine, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    } catch (err) {
      const friendly =
        err.message === "NOT_FOUND" || err.message === "ALREADY_PROCESSED"
          ? "Already handled — someone (or the admin panel) beat you to it."
          : "Action failed — check server logs.";
      console.error("Telegram callback_query error:", err.message);
      await bot.answerCallbackQuery(query.id, { text: friendly, show_alert: true });
    }
  });

  // ── Live events (requests + already-settled activity) ─────────────────
  adminEvents.on("event", (event) => {
    if (!bot) return;

    if (event.type === "deposit_request") {
      return sendDepositRequestCard(event);
    }
    if (event.type === "withdrawal_request") {
      return sendWithdrawalRequestCard(event);
    }

    const label = TYPE_LABELS[event.type];
    if (!label) return;

    const lines = [label, `Amount: ৳${Number(event.amount).toLocaleString()}`];
    if (event.game) lines.push(`Game: ${event.game}`);
    lines.push(`User: ${event.userId}`);
    safeSend(lines.join("\n"));
  });

  console.log("Telegram admin bot started (polling).");
}

function sendDepositRequestCard({ requestId, mobile, userId, amount, method, depositNumber, transactionId }) {
  const text = [
    "📥 NEW DEPOSIT REQUEST",
    `User: ${mobile || userId}`,
    `Amount: ৳${Number(amount).toLocaleString()}`,
    `Method: ${method}`,
    `Deposit Number: ${depositNumber}`,
    `Txn ID: ${transactionId}`,
    `Request #${requestId}`,
  ].join("\n");

  return bot.sendMessage(ADMIN_CHAT_ID, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:deposit:${requestId}` },
          { text: "❌ Reject", callback_data: `reject:deposit:${requestId}` },
        ],
      ],
    },
  }).catch((err) => console.error("Telegram send error:", err.message));
}

function sendWithdrawalRequestCard({ requestId, mobile, userId, amount, method, accountDetails }) {
  const text = [
    "📤 NEW WITHDRAWAL REQUEST",
    `User: ${mobile || userId}`,
    `Amount: ৳${Number(amount).toLocaleString()}`,
    `Method: ${method}`,
    `Payout to: ${accountDetails}`,
    `Request #${requestId}`,
  ].join("\n");

  return bot.sendMessage(ADMIN_CHAT_ID, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:withdrawal:${requestId}` },
          { text: "❌ Reject", callback_data: `reject:withdrawal:${requestId}` },
        ],
      ],
    },
  }).catch((err) => console.error("Telegram send error:", err.message));
}

function safeSend(text) {
  if (!bot) return;
  return bot.sendMessage(ADMIN_CHAT_ID, text).catch((err) => console.error("Telegram send error:", err.message));
}
