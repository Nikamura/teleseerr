import { createServer, type ServerResponse } from "http";
import type { Bot } from "grammy";
import { config } from "./config.js";
import { log } from "./logger.js";
import { accountStore } from "./stores.js";
import { handleWebhook, type SeerrWebhookPayload } from "./notifications.js";
import { addPendingAndNotify } from "./pending.js";
import { authenticate, type ValidAuth } from "./auth.js";
import {
  json,
  error,
  parseJsonBody,
  matchRoute,
  getAllowedOrigin,
  serveStatic,
  ClientError,
  type Route,
} from "./http.js";
import {
  handleTrending,
  handleSearch,
  handleCapabilities,
  handleMovieRecommendations,
  handleMovieSimilar,
  handleTvRecommendations,
  handleTvSimilar,
  handlePerson,
  handleRecentlyAdded,
  handleMovieDetails,
  handleTvDetails,
  handleMovieGenres,
  handleTvGenres,
  handleDiscoverUpcoming,
  handleDiscover,
  handleRequest,
  handleRequests,
  handleQuota,
  handleMovieProgress,
  handleTvProgress,
  setMediaBotInstance,
} from "./routes/media.js";
import {
  handleAdminPending,
  handleAdminUsers,
  handleAdminSeerrUsers,
  handleAdminLink,
  handleAdminIgnore,
  handleAdminIgnored,
  handleAdminUnignore,
  handleAdminUnlink,
  setAdminBotInstance,
} from "./routes/admin.js";

// ── Module State ──────────────────────────────────

let botUsername = "";
let botInstance: Bot | null = null;

// ── Me Handler (uses local botInstance) ───────────

function handleMe(res: ServerResponse, auth: ValidAuth): void {
  const account = accountStore.get(auth.userId);

  if (!account && auth.userId !== config.ADMIN_USER_ID && botInstance) {
    addPendingAndNotify(botInstance, {
      userId: auth.userId,
      firstName: auth.firstName,
      lastName: auth.lastName,
      username: auth.username,
    });
  }

  json(res, {
    linked: !!account,
    seerrUserId: account?.seerrUserId,
    seerrUsername: account?.seerrUsername,
    isAdmin: auth.userId === config.ADMIN_USER_ID,
    telegramUserId: auth.userId,
  });
}

// ── Route Table ───────────────────────────────────

const routes: Route[] = [
  // User routes
  { method: "GET", pattern: "/api/trending", handler: handleTrending },
  { method: "GET", pattern: "/api/search", handler: handleSearch },
  { method: "GET", pattern: "/api/capabilities", handler: handleCapabilities },
  { method: "GET", pattern: "/api/movie/:id/recommendations", handler: handleMovieRecommendations },
  { method: "GET", pattern: "/api/movie/:id/similar", handler: handleMovieSimilar },
  { method: "GET", pattern: "/api/tv/:id/recommendations", handler: handleTvRecommendations },
  { method: "GET", pattern: "/api/tv/:id/similar", handler: handleTvSimilar },
  { method: "GET", pattern: "/api/movie/:id/progress", handler: handleMovieProgress },
  { method: "GET", pattern: "/api/tv/:id/progress", handler: handleTvProgress },
  { method: "GET", pattern: "/api/person/:id", handler: handlePerson },
  { method: "GET", pattern: "/api/recently-added", handler: handleRecentlyAdded },
  { method: "GET", pattern: "/api/movie/:id", handler: handleMovieDetails },
  { method: "GET", pattern: "/api/tv/:id", handler: handleTvDetails },
  { method: "GET", pattern: "/api/genres/movie", handler: handleMovieGenres },
  { method: "GET", pattern: "/api/genres/tv", handler: handleTvGenres },
  { method: "GET", pattern: "/api/discover/upcoming/:type", handler: handleDiscoverUpcoming },
  { method: "GET", pattern: "/api/discover/:type", handler: handleDiscover },
  { method: "POST", pattern: "/api/request", handler: handleRequest },
  { method: "GET", pattern: "/api/requests", handler: handleRequests },
  { method: "GET", pattern: "/api/quota", handler: handleQuota },
  // Admin routes
  { method: "GET", pattern: "/api/admin/pending", handler: handleAdminPending, admin: true },
  { method: "GET", pattern: "/api/admin/users", handler: handleAdminUsers, admin: true },
  { method: "GET", pattern: "/api/admin/seerr-users", handler: handleAdminSeerrUsers, admin: true },
  { method: "POST", pattern: "/api/admin/link", handler: handleAdminLink, admin: true },
  { method: "POST", pattern: "/api/admin/ignore", handler: handleAdminIgnore, admin: true },
  { method: "GET", pattern: "/api/admin/ignored", handler: handleAdminIgnored, admin: true },
  { method: "POST", pattern: "/api/admin/unignore", handler: handleAdminUnignore, admin: true },
  { method: "POST", pattern: "/api/admin/unlink", handler: handleAdminUnlink, admin: true },
];

// ── API Dispatch ──────────────────────────────────

async function handleApi(
  req: import("http").IncomingMessage,
  res: import("http").ServerResponse,
  path: string,
  url: URL,
): Promise<void> {
  // Public endpoint — no auth
  if (req.method === "GET" && path === "/api/bot-info") {
    return json(res, { username: botUsername });
  }

  const auth = authenticate(req);
  if (!auth.valid) return error(res, "Unauthorized", 401);

  // Accessible before link check
  if (req.method === "GET" && path === "/api/me") {
    return handleMe(res, auth);
  }

  // All other endpoints require linked account (admin always passes)
  const isAdmin = auth.userId === config.ADMIN_USER_ID;
  if (!isAdmin && !accountStore.get(auth.userId)) {
    return error(res, "Account not linked", 403);
  }

  for (const route of routes) {
    if (req.method !== route.method) continue;
    const params = matchRoute(route.pattern, path);
    if (!params) continue;

    if (route.admin && !isAdmin) return error(res, "Forbidden", 403);
    return route.handler({ req, res, url, params, auth });
  }

  return error(res, "Not found", 404);
}

// ── Server ────────────────────────────────────────

export function startServer(bot: Bot): void {
  botInstance = bot;
  setAdminBotInstance(bot);
  setMediaBotInstance(bot);

  if (!config.MINI_APP_URL) {
    log.info("Mini App disabled (TELESEERR_MINI_APP_URL not set)");
    return;
  }

  const webhookPath = config.WEBHOOK_SECRET ? `/webhook/${config.WEBHOOK_SECRET}` : "";

  if (webhookPath) {
    log.info("Seerr webhook endpoint enabled");
  } else {
    log.warn("TELESEERR_WEBHOOK_SECRET not set — webhook notifications disabled");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      // Health check
      if (path === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // Seerr webhook
      if (webhookPath && path === webhookPath) {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = await parseJsonBody(req);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        await handleWebhook(body as SeerrWebhookPayload, bot);
        res.writeHead(204);
        res.end();
        return;
      }

      // API routes
      if (path.startsWith("/api/")) {
        const origin = getAllowedOrigin(req);
        if (origin) res.setHeader("Access-Control-Allow-Origin", origin);

        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, X-Telegram-Init-Data, X-Telegram-Login-Data",
          });
          res.end();
          return;
        }

        await handleApi(req, res, path, url);
        return;
      }

      // Static files / SPA fallback
      if (!(await serveStatic(res, path))) {
        await serveStatic(res, "/");
      }
    } catch (e) {
      if (e instanceof ClientError) {
        if (!res.headersSent) error(res, e.message, e.status);
      } else {
        log.error(e, "Server error");
        if (!res.headersSent) error(res, "Internal server error", 500);
      }
    }
  });

  server.listen(config.MINI_APP_PORT, () => {
    log.info({ port: config.MINI_APP_PORT }, "Mini App server started");
  });

  bot.api
    .getMe()
    .then((me) => {
      botUsername = me.username;
      log.info({ botUsername }, "Bot username cached for Login Widget");
    })
    .catch((e: unknown) => {
      log.warn(e, "Failed to fetch bot username for Login Widget");
    });
}
