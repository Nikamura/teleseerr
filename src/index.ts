import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { log } from "./logger.js";
import { loadCapabilities } from "./capabilities.js";
import { autoLinkAdmin } from "./handlers/link.js";
import { startServer } from "./server.js";
import { accountStore, pendingStore } from "./stores.js";

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// ── Interaction Logging Middleware ─────────────────

bot.use(async (ctx, next) => {
  const user = ctx.from;
  const username = user?.username ?? user?.first_name ?? String(user?.id ?? "?");

  if (ctx.message?.text) {
    log.info({ user: username, text: ctx.message.text, chat: ctx.chat?.type }, "message");
  }

  return next();
});

// ── Commands ──────────────────────────────────────

bot.command("start", async (ctx) => {
  if (!config.MINI_APP_URL) {
    await ctx.reply("Ahoy! The Mini App is not configured yet.");
    return;
  }

  const userId = ctx.from?.id;
  if (userId && userId !== config.ADMIN_USER_ID && !accountStore.get(userId)) {
    const isNew = pendingStore.add({
      telegramUserId: userId,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
      username: ctx.from?.username,
      requestedAt: Date.now(),
    });
    if (isNew) {
      const name =
        [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "Unknown";
      const userTag = ctx.from?.username ? ` (@${ctx.from.username})` : "";
      const adminKb = new InlineKeyboard().webApp("Link account", config.MINI_APP_URL);
      bot.api
        .sendMessage(
          config.ADMIN_USER_ID,
          `New user wants access!\n\nName: ${name}${userTag}\nTelegram ID: ${userId}`,
          { reply_markup: adminKb },
        )
        .catch((e: unknown) => {
          log.error(e, "Failed to notify admin about unlinked user");
        });
    }
  }

  const kb = new InlineKeyboard().webApp("Open Teleseerr", config.MINI_APP_URL);
  await ctx.reply("Ahoy! Tap below to browse and request media. 🏴‍☠️", {
    reply_markup: kb,
  });
});

// ── Error Handler ─────────────────────────────────

bot.catch((err) => {
  const e = err.error;

  if (e instanceof GrammyError) {
    log.error({ description: e.description, method: e.method }, "Telegram API error");
  } else if (e instanceof HttpError) {
    log.error({ error: e.message }, "HTTP error");
  } else {
    log.error(e, "Unhandled error");
  }
});

// ── Startup ───────────────────────────────────────

async function main() {
  log.info("Starting Teleseerr bot...");

  // Fetch Seerr capabilities (4K availability, etc.)
  await loadCapabilities();

  // Auto-link admin if configured
  await autoLinkAdmin();

  // Set commands menu
  await bot.api.setMyCommands([{ command: "start", description: "Open Teleseerr" }]);

  // Set menu button to open Mini App directly
  if (config.MINI_APP_URL) {
    try {
      await bot.api.setChatMenuButton({
        menu_button: {
          type: "web_app",
          text: "Teleseerr",
          web_app: { url: config.MINI_APP_URL },
        },
      });
      log.info("Menu button set to Mini App");
    } catch (e) {
      log.warn(e, "Failed to set menu button");
    }
  }

  // Start Mini App server + webhook endpoint (if configured)
  startServer(bot);

  log.info({ botUsername: (await bot.api.getMe()).username }, "Bot started");
  void bot.start();
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  log.info("SIGTERM received, shutting down...");
  await bot.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  log.info("SIGINT received, shutting down...");
  await bot.stop();
  process.exit(0);
});

main().catch((e: unknown) => {
  log.fatal(e, "Failed to start bot");
  process.exit(1);
});
