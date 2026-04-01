import type { IncomingMessage, ServerResponse } from "http";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, extname } from "path";
import { config } from "./config.js";
import type { ValidAuth } from "./auth.js";

// ── Constants ─────────────────────────────────────

export const MAX_BODY_SIZE = 1_048_576; // 1 MB

export const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export const WEB_DIR = join(__dirname, "..", "web");

// ── Errors ────────────────────────────────────────

export class ClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── CORS ──────────────────────────────────────────

export function getAllowedOrigin(req: IncomingMessage): string | null {
  if (!config.MINI_APP_URL) return null;
  const origin = req.headers.origin;
  if (!origin) return null;
  try {
    return origin === new URL(config.MINI_APP_URL).origin ? origin : null;
  } catch {
    return null;
  }
}

// ── Response Helpers ──────────────────────────────

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function error(res: ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

// ── Body Parsing ──────────────────────────────────

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_SIZE) throw new ClientError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

// ── Static File Serving ───────────────────────────

export async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
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

// ── Route Matching ────────────────────────────────

export function matchRoute(pattern: string, path: string): Record<string, string> | null {
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

export function numParam(params: Record<string, string>, key: string): number {
  const raw = params[key];
  if (raw === undefined) throw new ClientError(400, `Missing parameter: ${key}`);
  const val = Number(raw);
  if (isNaN(val)) throw new ClientError(400, `Invalid parameter: ${key}`);
  return val;
}

export function pageParam(url: URL): number {
  return Number(url.searchParams.get("page") ?? "1");
}

// ── Route Types ───────────────────────────────────

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  auth: ValidAuth;
};

export type Route = {
  method: string;
  pattern: string;
  handler: (ctx: RouteContext) => void | Promise<void>;
  admin?: boolean;
};
