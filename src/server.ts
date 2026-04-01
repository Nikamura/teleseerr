import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, extname } from "path";
import { InlineKeyboard, type Bot } from "grammy";
import { config } from "./config.js";
import { log } from "./logger.js";
import { accountStore, pendingStore, canRequest, canSearch } from "./stores.js";
import * as seerr from "./seerr/client.js";
import type { AccountLink } from "./types.js";
import { handleWebhook, type SeerrWebhookPayload } from "./notifications.js";
import { capabilities } from "./capabilities.js";
import { addPendingAndNotify } from "./pending.js";

// ── Constants ──────────────────────────────────────

const MAX_BODY_SIZE = 1_048_576; // 1 MB

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

// ── Errors ─────────────────────────────────────────

class ClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── Auth ───────────────────────────────────────────

type AuthResult = { valid: false } | ValidAuth;

type ValidAuth = {
  valid: true;
  userId: number;
  firstName?: string | undefined;
  lastName?: string | undefined;
  username?: string | undefined;
};

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

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

  if (!safeCompare(computedHash, hash)) return { valid: false };

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
    if (typeof hash !== "string") return { valid: false };

    const authDate = Number(rest["auth_date"]);
    if (isNaN(authDate) || Date.now() / 1000 - authDate > 30 * 86400) {
      return { valid: false };
    }

    const entries = Object.entries(rest).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${String(v)}`).join("\n");

    const secretKey = createHash("sha256").update(config.TELEGRAM_BOT_TOKEN).digest();
    const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (!safeCompare(computedHash, hash)) return { valid: false };

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

// ── CORS ───────────────────────────────────────────

function getAllowedOrigin(req: IncomingMessage): string | null {
  if (!config.MINI_APP_URL) return null;
  const origin = req.headers.origin;
  if (!origin) return null;
  try {
    return origin === new URL(config.MINI_APP_URL).origin ? origin : null;
  } catch {
    return null;
  }
}

// ── Response Helpers ───────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

// ── Body Parsing ───────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_SIZE) throw new ClientError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClientError(400, "Invalid JSON");
  }
  if (!isRecord(parsed)) throw new ClientError(400, "Body must be a JSON object");
  return parsed;
}

// ── Static File Serving ────────────────────────────

async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  const filePath = join(WEB_DIR, urlPath === "/" ? "index.html" : urlPath);

  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end();
    return true;
  }

  if (!existsSync(filePath)) return false;

  const ext = extname(filePath);
  const contentType = MIME[ext] ?? "application/octet-stream";
  const content = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(content);
  return true;
}

// ── Route Matching ─────────────────────────────────

function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    const pathPart = pathParts[i];
    if (pp === undefined || pathPart === undefined) return null;
    if (pp.startsWith(":")) {
      params[pp.slice(1)] = pathPart;
    } else if (pp !== pathPart) {
      return null;
    }
  }
  return params;
}

function numParam(params: Record<string, string>, key: string): number {
  const raw = params[key];
  if (raw === undefined) throw new ClientError(400, `Missing parameter: ${key}`);
  const val = Number(raw);
  if (isNaN(val)) throw new ClientError(400, `Invalid parameter: ${key}`);
  return val;
}

// ── Route Types ────────────────────────────────────

type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  auth: ValidAuth;
};

type Route = {
  method: string;
  pattern: string;
  handler: (ctx: RouteContext) => void | Promise<void>;
  admin?: boolean;
};

// ── Route Handlers ─────────────────────────────────

async function handleTrending({ res, url }: RouteContext): Promise<void> {
  const page = Number(url.searchParams.get("page") ?? "1");
  json(res, await seerr.getTrending(page));
}

async function handleSearch({ res, url, auth }: RouteContext): Promise<void> {
  if (!canSearch(auth.userId)) return error(res, "Too many requests", 429);
  const q = url.searchParams.get("q") ?? "";
  if (q.length < 2) return json(res, { results: [], totalPages: 0, totalResults: 0 });
  const page = Number(url.searchParams.get("page") ?? "1");
  json(res, await seerr.search(q, page));
}

function handleCapabilities({ res }: RouteContext): void {
  json(res, { has4kMovie: capabilities.has4kMovie, has4kTv: capabilities.has4kTv });
}

async function handleMovieRecommendations({ res, url, params }: RouteContext): Promise<void> {
  const page = Number(url.searchParams.get("page") ?? "1");
  json(res, await seerr.getMovieRecommendations(numParam(params, "id"), page));
}

async function handleMovieSimilar({ res, url, params }: RouteContext): Promise<void> {
  const page = Number(url.searchParams.get("page") ?? "1");
  json(res, await seerr.getMovieSimilar(numParam(params, "id"), page));
}

async function handleTvRecommendations({ res, url, params }: RouteContext): Promise<void> {
  const page = Number(url.searchParams.get("page") ?? "1");
  json(res, await seerr.getTvRecommendations(numParam(params, "id"), page));
}

async function handleTvSimilar({ res, url, params }: RouteContext): Promise<void> {
  const page = Number(url.searchParams.get("page") ?? "1");
  json(res, await seerr.getTvSimilar(numParam(params, "id"), page));
}

async function handlePerson({ res, params }: RouteContext): Promise<void> {
  const id = numParam(params, "id");
  const [details, credits] = await Promise.all([
    seerr.getPersonDetails(id),
    seerr.getPersonCombinedCredits(id),
  ]);
  json(res, { ...details, combinedCredits: credits });
}

async function handleRecentlyAdded({ res, url }: RouteContext): Promise<void> {
  const page = Number(url.searchParams.get("page") ?? "1");
  const take = 20;

  try {
    const mediaData = await seerr.getRecentlyAdded(take, (page - 1) * take);
    const enriched = await Promise.all(
      mediaData.results.map(async (item) => {
        try {
          if (item.mediaType === "movie") {
            const m = await seerr.getMovieDetails(item.tmdbId);
            return { ...m, mediaType: "movie" as const };
          }
          const t = await seerr.getTvDetails(item.tmdbId);
          return { ...t, mediaType: "tv" as const };
        } catch {
          return null;
        }
      }),
    );
    json(res, {
      results: enriched.filter(Boolean),
      totalPages: mediaData.pageInfo.pages,
      totalResults: mediaData.pageInfo.results,
      page,
    });
  } catch (e) {
    log.error(e, "Recently added failed");
    json(res, { results: [], totalPages: 0, totalResults: 0, page });
  }
}

async function handleMovieDetails({ res, params }: RouteContext): Promise<void> {
  json(res, await seerr.getMovieDetails(numParam(params, "id")));
}

async function handleTvDetails({ res, params }: RouteContext): Promise<void> {
  json(res, await seerr.getTvDetails(numParam(params, "id")));
}

async function handleMovieGenres({ res }: RouteContext): Promise<void> {
  json(res, await seerr.getGenres("movie"));
}

async function handleTvGenres({ res }: RouteContext): Promise<void> {
  json(res, await seerr.getGenres("tv"));
}

async function handleDiscoverUpcoming({ res, url, params }: RouteContext): Promise<void> {
  const page = Number(url.searchParams.get("page") ?? "1");
  json(res, await seerr.discoverUpcoming(params["type"] as "movie" | "tv", page));
}

async function handleDiscover({ res, url, params }: RouteContext): Promise<void> {
  const type = params["type"] as "movie" | "tv";
  const genre = url.searchParams.get("genre");
  json(
    res,
    await seerr.discover(type, {
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
    }),
  );
}

async function handleRequest({ req, res, auth }: RouteContext): Promise<void> {
  if (!canRequest(auth.userId)) return error(res, "Too many requests", 429);

  const body = await parseJsonBody(req);
  if (body["mediaType"] !== "movie" && body["mediaType"] !== "tv") {
    return error(res, "Invalid mediaType");
  }
  if (typeof body["mediaId"] !== "number") return error(res, "Invalid mediaId");

  const mediaType = body["mediaType"];
  const mediaId = body["mediaId"];

  const account = accountStore.get(auth.userId);
  if (!account) return error(res, "Account not linked", 403);

  let serverId: number | undefined;
  if (mediaType === "tv" && capabilities.animeSonarrId) {
    try {
      const details = await seerr.getTvDetails(mediaId);
      if (details.keywords.some((k) => k.id === 210024)) {
        serverId = capabilities.animeSonarrId;
      }
    } catch {
      /* use default */
    }
  }

  const result = await seerr.createRequest({
    mediaType,
    mediaId,
    seasons: Array.isArray(body["seasons"]) ? (body["seasons"] as number[]) : undefined,
    is4k: body["is4k"] === true,
    userId: account.seerrUserId,
    serverId,
  });
  json(res, result, result.success ? 201 : 400);
}

async function handleRequests({ res, url, auth }: RouteContext): Promise<void> {
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

  const enriched = await Promise.all(
    data.results.map(async (r) => {
      let title = `TMDB#${r.media.tmdbId}`;
      let posterPath: string | null = null;
      try {
        if (r.media.mediaType === "movie") {
          const m = await seerr.getMovieDetails(r.media.tmdbId);
          title = m.title ?? title;
          posterPath = m.posterPath;
        } else if (r.media.mediaType === "tv") {
          const t = await seerr.getTvDetails(r.media.tmdbId);
          title = t.name ?? title;
          posterPath = t.posterPath;
        }
      } catch {
        /* use fallback */
      }
      return {
        id: r.id,
        tmdbId: r.media.tmdbId,
        title,
        posterPath,
        mediaType: r.media.mediaType,
        status: r.status,
        mediaStatus: r.media.status,
        is4k: r.is4k,
        createdAt: r.createdAt,
      };
    }),
  );

  json(res, { results: enriched, pageInfo: data.pageInfo });
}

async function handleQuota({ res, auth }: RouteContext): Promise<void> {
  const account = accountStore.get(auth.userId);
  if (!account) return error(res, "Account not linked", 403);
  json(res, await seerr.getUserQuota(account.seerrUserId));
}

// ── Admin Route Handlers ───────────────────────────

function handleAdminPending({ res }: RouteContext): void {
  json(res, pendingStore.getAll());
}

function handleAdminUsers({ res }: RouteContext): void {
  json(res, accountStore.getAll());
}

async function handleAdminSeerrUsers({ res, url }: RouteContext): Promise<void> {
  const page = Number(url.searchParams.get("page") ?? "1");
  json(res, await seerr.getUsers({ take: 20, skip: (page - 1) * 20 }));
}

async function handleAdminLink({ req, res }: RouteContext): Promise<void> {
  const body = await parseJsonBody(req);
  if (typeof body["telegramUserId"] !== "number" || typeof body["seerrUserId"] !== "number") {
    return error(res, "Missing telegramUserId or seerrUserId");
  }
  const telegramUserId = body["telegramUserId"];
  const seerrUserId = body["seerrUserId"];

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

  json(res, link, 201);
}

async function handleAdminIgnore({ req, res }: RouteContext): Promise<void> {
  const body = await parseJsonBody(req);
  if (typeof body["telegramUserId"] !== "number") return error(res, "Missing telegramUserId");
  pendingStore.ignore(body["telegramUserId"]);
  json(res, { success: true });
}

function handleAdminIgnored({ res }: RouteContext): void {
  json(res, pendingStore.getIgnored());
}

async function handleAdminUnignore({ req, res }: RouteContext): Promise<void> {
  const body = await parseJsonBody(req);
  if (typeof body["telegramUserId"] !== "number") return error(res, "Missing telegramUserId");
  pendingStore.unignore(body["telegramUserId"]);
  json(res, { success: true });
}

async function handleAdminUnlink({ req, res }: RouteContext): Promise<void> {
  const body = await parseJsonBody(req);
  if (typeof body["telegramUserId"] !== "number") return error(res, "Missing telegramUserId");
  accountStore.delete(body["telegramUserId"]);
  json(res, { success: true });
}

// ── Route Table ────────────────────────────────────

const routes: Route[] = [
  // User routes
  { method: "GET", pattern: "/api/trending", handler: handleTrending },
  { method: "GET", pattern: "/api/search", handler: handleSearch },
  { method: "GET", pattern: "/api/capabilities", handler: handleCapabilities },
  { method: "GET", pattern: "/api/movie/:id/recommendations", handler: handleMovieRecommendations },
  { method: "GET", pattern: "/api/movie/:id/similar", handler: handleMovieSimilar },
  { method: "GET", pattern: "/api/tv/:id/recommendations", handler: handleTvRecommendations },
  { method: "GET", pattern: "/api/tv/:id/similar", handler: handleTvSimilar },
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
  // Admin routes (admin flag = single guard)
  { method: "GET", pattern: "/api/admin/pending", handler: handleAdminPending, admin: true },
  { method: "GET", pattern: "/api/admin/users", handler: handleAdminUsers, admin: true },
  { method: "GET", pattern: "/api/admin/seerr-users", handler: handleAdminSeerrUsers, admin: true },
  { method: "POST", pattern: "/api/admin/link", handler: handleAdminLink, admin: true },
  { method: "POST", pattern: "/api/admin/ignore", handler: handleAdminIgnore, admin: true },
  { method: "GET", pattern: "/api/admin/ignored", handler: handleAdminIgnored, admin: true },
  { method: "POST", pattern: "/api/admin/unignore", handler: handleAdminUnignore, admin: true },
  { method: "POST", pattern: "/api/admin/unlink", handler: handleAdminUnlink, admin: true },
];

// ── API Dispatch ───────────────────────────────────

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

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
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

// ── Server ─────────────────────────────────────────

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
