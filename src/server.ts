import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHash, createHmac } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { InlineKeyboard, type Bot } from "grammy";
import { config } from "./config.js";
import { log } from "./logger.js";
import { accountStore, pendingStore, canRequest } from "./stores.js";
import * as seerr from "./seerr/client.js";
import type { AccountLink } from "./types.js";
import { handleWebhook, type SeerrWebhookPayload } from "./notifications.js";
import { capabilities } from "./capabilities.js";

// ── Auth Validation ─────────────────────────────────

type AuthResult =
  | { valid: false }
  | {
      valid: true;
      userId: number;
      firstName?: string | undefined;
      lastName?: string | undefined;
      username?: string | undefined;
    };

function validateInitData(initData: string): AuthResult {
  if (!initData) return { valid: false };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { valid: false };

  params.delete("hash");
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(config.TELEGRAM_BOT_TOKEN).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return { valid: false };

  try {
    const user = JSON.parse(params.get("user") ?? "{}") as {
      id?: number;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    if (user.id == null) return { valid: false };
    return {
      valid: true,
      userId: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
    };
  } catch {
    return { valid: false };
  }
}

function validateLoginWidget(data: string): AuthResult {
  if (!data) return { valid: false };

  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const { hash, ...rest } = parsed;
    if (!hash) return { valid: false };

    // Reject auth older than 30 days
    const authDate = Number(rest["auth_date"]);
    if (isNaN(authDate) || Date.now() / 1000 - authDate > 30 * 86400) {
      return { valid: false };
    }

    const entries = Object.entries(rest).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${String(v)}`).join("\n");

    // Login Widget: secret = SHA256(bot_token)
    const secretKey = createHash("sha256").update(config.TELEGRAM_BOT_TOKEN).digest();
    const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (computedHash !== hash) return { valid: false };

    const userId = Number(parsed["id"]);
    if (isNaN(userId)) return { valid: false };
    return {
      valid: true,
      userId,
      firstName: parsed["first_name"] as string | undefined,
      lastName: parsed["last_name"] as string | undefined,
      username: parsed["username"] as string | undefined,
    };
  } catch {
    return { valid: false };
  }
}

function authenticate(req: IncomingMessage): AuthResult {
  const initData = req.headers["x-telegram-init-data"] as string | undefined;
  if (initData) return validateInitData(initData);

  const loginData = req.headers["x-telegram-login-data"] as string | undefined;
  if (loginData) return validateLoginWidget(loginData);

  return { valid: false };
}

// ── Static File Serving ──────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const WEB_DIR = join(__dirname, "..", "web");

function serveStatic(res: ServerResponse, urlPath: string): boolean {
  const filePath = join(WEB_DIR, urlPath === "/" ? "index.html" : urlPath);

  // Prevent path traversal
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end();
    return true;
  }

  if (!existsSync(filePath)) return false;

  const ext = extname(filePath);
  const contentType = MIME[ext] ?? "application/octet-stream";
  const content = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(content);
  return true;
}

// ── API Router ───────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

type RouteMatch = {
  params: Record<string, string>;
};

function param(match: RouteMatch, key: string): string {
  const val = match.params[key];
  if (val === undefined) throw new Error(`Missing route param: ${key}`);
  return val;
}

function matchRoute(pattern: string, path: string): RouteMatch | null {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];
    if (patternPart === undefined || pathPart === undefined) return null;
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = pathPart;
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return { params };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data, X-Telegram-Login-Data",
    });
    res.end();
    return;
  }

  // GET /api/bot-info — public, no auth required
  if (req.method === "GET" && path === "/api/bot-info") {
    return json(res, { username: botUsername });
  }

  // Validate auth (Web App initData or Login Widget)
  const auth = authenticate(req);
  if (!auth.valid) {
    return error(res, "Unauthorized", 401);
  }

  // GET /api/me — must be accessible before link check
  if (req.method === "GET" && path === "/api/me") {
    const account = accountStore.get(auth.userId);

    // Add to pending and notify admin (once per user)
    if (!account && auth.userId !== config.ADMIN_USER_ID) {
      const isNew = pendingStore.add({
        telegramUserId: auth.userId,
        firstName: auth.firstName,
        lastName: auth.lastName,
        username: auth.username,
        requestedAt: Date.now(),
      });
      if (isNew && botInstance) {
        const name = [auth.firstName, auth.lastName].filter(Boolean).join(" ") || "Unknown";
        const userTag = auth.username ? ` (@${auth.username})` : "";
        const kb = new InlineKeyboard().webApp("Link account", config.MINI_APP_URL);
        botInstance.api
          .sendMessage(
            config.ADMIN_USER_ID,
            `New user wants access!\n\nName: ${name}${userTag}\nTelegram ID: ${auth.userId}`,
            { reply_markup: kb },
          )
          .catch((e: unknown) => {
            log.error(e, "Failed to notify admin about unlinked user");
          });
      }
    }

    return json(res, {
      linked: !!account,
      seerrUserId: account?.seerrUserId,
      seerrUsername: account?.seerrUsername,
      isAdmin: auth.userId === config.ADMIN_USER_ID,
      telegramUserId: auth.userId,
    });
  }

  // Block unlinked non-admin users from all other endpoints
  const isAdmin = auth.userId === config.ADMIN_USER_ID;
  if (!isAdmin && !accountStore.get(auth.userId)) {
    return error(res, "Account not linked", 403);
  }

  // GET /api/trending?page=1
  if (req.method === "GET" && path === "/api/trending") {
    const page = Number(url.searchParams.get("page") ?? "1");
    const data = await seerr.getTrending(page);
    return json(res, data);
  }

  // GET /api/search?q=...&page=1
  if (req.method === "GET" && path === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    if (q.length < 2) return json(res, { results: [], totalPages: 0, totalResults: 0 });
    const page = Number(url.searchParams.get("page") ?? "1");
    const data = await seerr.search(q, page);
    return json(res, data);
  }

  // GET /api/movie/:id/recommendations
  let match = matchRoute("/api/movie/:id/recommendations", path);
  if (req.method === "GET" && match) {
    const page = Number(url.searchParams.get("page") ?? "1");
    const data = await seerr.getMovieRecommendations(Number(param(match, "id")), page);
    return json(res, data);
  }

  // GET /api/movie/:id/similar
  match = matchRoute("/api/movie/:id/similar", path);
  if (req.method === "GET" && match) {
    const page = Number(url.searchParams.get("page") ?? "1");
    const data = await seerr.getMovieSimilar(Number(param(match, "id")), page);
    return json(res, data);
  }

  // GET /api/tv/:id/recommendations
  match = matchRoute("/api/tv/:id/recommendations", path);
  if (req.method === "GET" && match) {
    const page = Number(url.searchParams.get("page") ?? "1");
    const data = await seerr.getTvRecommendations(Number(param(match, "id")), page);
    return json(res, data);
  }

  // GET /api/tv/:id/similar
  match = matchRoute("/api/tv/:id/similar", path);
  if (req.method === "GET" && match) {
    const page = Number(url.searchParams.get("page") ?? "1");
    const data = await seerr.getTvSimilar(Number(param(match, "id")), page);
    return json(res, data);
  }

  // GET /api/person/:id
  match = matchRoute("/api/person/:id", path);
  if (req.method === "GET" && match) {
    const [details, credits] = await Promise.all([
      seerr.getPersonDetails(Number(param(match, "id"))),
      seerr.getPersonCombinedCredits(Number(param(match, "id"))),
    ]);
    return json(res, { ...details, combinedCredits: credits });
  }

  // GET /api/recently-added?page=1
  if (req.method === "GET" && path === "/api/recently-added") {
    const page = Number(url.searchParams.get("page") ?? "1");
    const take = 20;

    try {
      const mediaData = await seerr.getRecentlyAdded(take, (page - 1) * take);

      const enriched = await Promise.all(
        mediaData.results.map(async (item) => {
          const { mediaType, tmdbId } = item;
          try {
            if (mediaType === "movie") {
              const m = await seerr.getMovieDetails(tmdbId);
              return { ...m, mediaType: "movie" as const };
            } else {
              const t = await seerr.getTvDetails(tmdbId);
              return { ...t, mediaType: "tv" as const };
            }
          } catch {
            return null;
          }
        }),
      );

      return json(res, {
        results: enriched.filter(Boolean),
        totalPages: mediaData.pageInfo.pages,
        totalResults: mediaData.pageInfo.results,
        page,
      });
    } catch (e) {
      log.error(e, "Recently added failed");
      return json(res, { results: [], totalPages: 0, totalResults: 0, page });
    }
  }

  // GET /api/movie/:id
  match = matchRoute("/api/movie/:id", path);
  if (req.method === "GET" && match) {
    const data = await seerr.getMovieDetails(Number(param(match, "id")));
    return json(res, data);
  }

  // GET /api/tv/:id
  match = matchRoute("/api/tv/:id", path);
  if (req.method === "GET" && match) {
    const data = await seerr.getTvDetails(Number(param(match, "id")));
    return json(res, data);
  }

  // GET /api/genres/movie
  if (req.method === "GET" && path === "/api/genres/movie") {
    const data = await seerr.getGenres("movie");
    return json(res, data);
  }

  // GET /api/genres/tv
  if (req.method === "GET" && path === "/api/genres/tv") {
    const data = await seerr.getGenres("tv");
    return json(res, data);
  }

  // GET /api/discover/upcoming/:type
  match = matchRoute("/api/discover/upcoming/:type", path);
  if (req.method === "GET" && match) {
    const page = Number(url.searchParams.get("page") ?? "1");
    const data = await seerr.discoverUpcoming(param(match, "type") as "movie" | "tv", page);
    return json(res, data);
  }

  // GET /api/discover/:type?genre=28&page=1&sortBy=...&yearGte=...&yearLte=...&ratingGte=...&ratingLte=...
  match = matchRoute("/api/discover/:type", path);
  if (req.method === "GET" && match) {
    const type = param(match, "type") as "movie" | "tv";
    const genre = url.searchParams.get("genre");
    const data = await seerr.discover(type, {
      genre: genre ? Number(genre) : undefined,
      page: Number(url.searchParams.get("page") ?? "1"),
      sortBy: url.searchParams.get("sortBy") ?? undefined,
      primaryReleaseDateGte: url.searchParams.get("primaryReleaseDateGte") ?? undefined,
      primaryReleaseDateLte: url.searchParams.get("primaryReleaseDateLte") ?? undefined,
      firstAirDateGte: url.searchParams.get("firstAirDateGte") ?? undefined,
      firstAirDateLte: url.searchParams.get("firstAirDateLte") ?? undefined,
      voteAverageGte: url.searchParams.get("voteAverageGte") ?? undefined,
      voteAverageLte: url.searchParams.get("voteAverageLte") ?? undefined,
      keywords: url.searchParams.get("keywords") ?? undefined,
    });
    return json(res, data);
  }

  // POST /api/request
  if (req.method === "POST" && path === "/api/request") {
    if (!canRequest(auth.userId)) {
      return error(res, "Too many requests", 429);
    }
    const body = JSON.parse(await readBody(req)) as {
      mediaType: "movie" | "tv";
      mediaId: number;
      seasons?: number[];
      is4k?: boolean;
    };
    const account = accountStore.get(auth.userId);
    if (!account) return error(res, "Account not linked", 403);
    const seerrUserId = account.seerrUserId;

    // Route anime to dedicated Sonarr if configured
    let serverId: number | undefined;
    if (body.mediaType === "tv" && capabilities.animeSonarrId) {
      try {
        const details = await seerr.getTvDetails(body.mediaId);
        const isAnime = details.keywords.some((k) => k.id === 210024);
        if (isAnime) serverId = capabilities.animeSonarrId;
      } catch {
        /* use default */
      }
    }

    const result = await seerr.createRequest({
      mediaType: body.mediaType,
      mediaId: body.mediaId,
      seasons: body.seasons,
      is4k: body.is4k ?? false,
      userId: seerrUserId,
      serverId,
    });
    return json(res, result, result.success ? 201 : 400);
  }

  // GET /api/requests?page=1
  if (req.method === "GET" && path === "/api/requests") {
    const account = accountStore.get(auth.userId);
    if (!account) return error(res, "Account not linked", 403);

    const page = Number(url.searchParams.get("page") ?? "1");
    const take = 15;
    const data = await seerr.getRequests({
      take,
      skip: (page - 1) * take,
      sort: "added",
      requestedBy: account.seerrUserId,
    });

    // Resolve titles in parallel
    const enriched = await Promise.all(
      data.results.map(async (req) => {
        let title = `TMDB#${req.media.tmdbId}`;
        let posterPath: string | null = null;
        try {
          if (req.media.mediaType === "movie") {
            const m = await seerr.getMovieDetails(req.media.tmdbId);
            title = m.title ?? title;
            posterPath = m.posterPath;
          } else if (req.media.mediaType === "tv") {
            const t = await seerr.getTvDetails(req.media.tmdbId);
            title = t.name ?? title;
            posterPath = t.posterPath;
          }
        } catch {
          /* use fallback title */
        }
        return {
          id: req.id,
          tmdbId: req.media.tmdbId,
          title,
          posterPath,
          mediaType: req.media.mediaType,
          status: req.status,
          mediaStatus: req.media.status,
          is4k: req.is4k,
          createdAt: req.createdAt,
        };
      }),
    );

    return json(res, { results: enriched, pageInfo: data.pageInfo });
  }

  // GET /api/quota
  if (req.method === "GET" && path === "/api/quota") {
    const account = accountStore.get(auth.userId);
    if (!account) return error(res, "Account not linked", 403);
    const quota = await seerr.getUserQuota(account.seerrUserId);
    return json(res, quota);
  }

  // ── Admin Endpoints ──────────────────────────────

  // GET /api/admin/pending
  if (req.method === "GET" && path === "/api/admin/pending") {
    if (auth.userId !== config.ADMIN_USER_ID) return error(res, "Forbidden", 403);
    return json(res, pendingStore.getAll());
  }

  // GET /api/admin/users
  if (req.method === "GET" && path === "/api/admin/users") {
    if (auth.userId !== config.ADMIN_USER_ID) return error(res, "Forbidden", 403);
    const links = accountStore.getAll();
    return json(res, links);
  }

  // GET /api/admin/seerr-users?page=1
  if (req.method === "GET" && path === "/api/admin/seerr-users") {
    if (auth.userId !== config.ADMIN_USER_ID) return error(res, "Forbidden", 403);
    const page = Number(url.searchParams.get("page") ?? "1");
    const data = await seerr.getUsers({ take: 20, skip: (page - 1) * 20 });
    return json(res, data);
  }

  // POST /api/admin/link
  if (req.method === "POST" && path === "/api/admin/link") {
    if (auth.userId !== config.ADMIN_USER_ID) return error(res, "Forbidden", 403);
    const body = JSON.parse(await readBody(req)) as {
      telegramUserId?: number;
      seerrUserId?: number;
    };
    const { telegramUserId, seerrUserId } = body;
    if (!telegramUserId || !seerrUserId) return error(res, "Missing telegramUserId or seerrUserId");

    const seerrUser = await seerr.getUser(seerrUserId);
    if (!seerrUser) return error(res, "Seerr user not found", 404);

    const link: AccountLink = {
      telegramUserId,
      seerrUserId: seerrUser.id,
      seerrUsername: seerrUser.username || seerrUser.email,
      linkedAt: Date.now(),
    };
    accountStore.set(link);
    pendingStore.remove(telegramUserId);

    // Notify the user they've been linked
    if (botInstance && config.MINI_APP_URL) {
      const kb = new InlineKeyboard().webApp("Open Teleseerr", config.MINI_APP_URL);
      botInstance.api
        .sendMessage(
          telegramUserId,
          "Your account has been linked! You can now browse and request media.",
          { reply_markup: kb },
        )
        .catch((e: unknown) => {
          log.error(e, "Failed to notify user about linking");
        });
    }

    return json(res, link, 201);
  }

  // POST /api/admin/ignore
  if (req.method === "POST" && path === "/api/admin/ignore") {
    if (auth.userId !== config.ADMIN_USER_ID) return error(res, "Forbidden", 403);
    const body = JSON.parse(await readBody(req)) as { telegramUserId?: number };
    const { telegramUserId } = body;
    if (!telegramUserId) return error(res, "Missing telegramUserId");
    pendingStore.ignore(telegramUserId);
    return json(res, { success: true });
  }

  // GET /api/admin/ignored
  if (req.method === "GET" && path === "/api/admin/ignored") {
    if (auth.userId !== config.ADMIN_USER_ID) return error(res, "Forbidden", 403);
    return json(res, pendingStore.getIgnored());
  }

  // POST /api/admin/unignore
  if (req.method === "POST" && path === "/api/admin/unignore") {
    if (auth.userId !== config.ADMIN_USER_ID) return error(res, "Forbidden", 403);
    const body = JSON.parse(await readBody(req)) as { telegramUserId?: number };
    const { telegramUserId } = body;
    if (!telegramUserId) return error(res, "Missing telegramUserId");
    pendingStore.unignore(telegramUserId);
    return json(res, { success: true });
  }

  // POST /api/admin/unlink
  if (req.method === "POST" && path === "/api/admin/unlink") {
    if (auth.userId !== config.ADMIN_USER_ID) return error(res, "Forbidden", 403);
    const body = JSON.parse(await readBody(req)) as { telegramUserId?: number };
    const { telegramUserId } = body;
    if (!telegramUserId) return error(res, "Missing telegramUserId");
    accountStore.delete(telegramUserId);
    return json(res, { success: true });
  }

  return error(res, "Not found", 404);
}

// ── Server ───────────────────────────────────────────

let botUsername = "";
let botInstance: Bot | null = null;

export function startServer(bot: Bot): void {
  botInstance = bot;

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
    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname;

    try {
      // Seerr webhook endpoint
      if (webhookPath && path === webhookPath) {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = JSON.parse(await readBody(req)) as SeerrWebhookPayload;
        await handleWebhook(body, bot);
        res.writeHead(204);
        res.end();
        return;
      }

      if (path.startsWith("/api/")) {
        await handleApi(req, res, path);
      } else if (!serveStatic(res, path)) {
        // SPA fallback — serve index.html
        serveStatic(res, "/");
      }
    } catch (e) {
      log.error(e, "Server error");
      if (!res.headersSent) {
        error(res, "Internal server error", 500);
      }
    }
  });

  server.listen(config.MINI_APP_PORT, () => {
    log.info({ port: config.MINI_APP_PORT }, "Mini App server started");
  });

  // Fetch bot username for Login Widget
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
