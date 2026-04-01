# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev             # tsx watch src/index.ts (live reload)
pnpm build           # tsc → dist/
pnpm start           # node dist/index.js
pnpm lint            # eslint src/
pnpm lint:fix        # eslint src/ --fix
pnpm format          # prettier --write src/
pnpm format:check    # prettier --check src/
pnpm typecheck       # tsc --noEmit
```

No test suite exists.

## Architecture

Single Node.js process: grammY bot (long polling) + HTTP server (Mini App + Seerr webhook).

```
index.ts          Bot entry point (/start, error handling, graceful shutdown)
  └─ server.ts    HTTP server: all API routes, dual auth, static file serving
       ├─ seerr/client.ts    Seerr REST wrapper (X-Api-Key auth, all endpoints)
       ├─ stores.ts          JSON file persistence (links, pending, ignored) + rate limiters
       ├─ notifications.ts   Seerr webhook → Telegram DM notifications
       └─ web/               Vanilla JS SPA (app.js, style.css, index.html)
```

### Key patterns

**Dual auth** — Mini App validates `X-Telegram-Init-Data` (HMAC-SHA256 with bot token). Browser fallback validates `X-Telegram-Login-Data` (Login Widget, 30-day expiry). Both extract Telegram user ID. Auth checked in `server.ts:authenticate()`.

**Account linking** — Users must be linked (Telegram ID → Seerr user ID) before accessing any endpoint except `/api/me`. Unlinked users see a waiting screen; admin gets notified. Links stored in `data/links.json`. Pending requests in `data/pending.json`, ignored users in `data/ignored.json`.

**Per-user attribution** — Requests to Seerr always include the linked `userId` so quotas and auto-approve rules apply per-user. No admin fallback for unlinked users.

**Capabilities** — On startup, `capabilities.ts` queries Seerr's Radarr/Sonarr services to detect 4K availability and anime Sonarr instance. Used by frontend to show/hide 4K toggles.

**Notifications** — Seerr posts webhooks to `POST /webhook/<SECRET>`. Handler in `notifications.ts` maps Seerr username → Telegram user via the link store, then sends a DM.

### Frontend (web/)

Vanilla JS SPA — no build step, no framework. Served as static files by `server.ts`. Uses Telegram Web App SDK for theming. CSS uses Telegram theme CSS variables mapped to shadcn-style tokens.

### Config

All env vars prefixed `TELESEERR_` — see `src/config.ts` for the full list and defaults. Required: `TELEGRAM_BOT_TOKEN`, `SEERR_URL`, `SEERR_API_KEY`, `TELESEERR_ADMIN_USER_ID`.

### Seerr-only

No direct Sonarr/Radarr API calls. Everything goes through Seerr's API. Season-level granularity only (Seerr's limit).
