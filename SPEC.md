# Teleseerr Bot — Technical Specification

> A Telegram Mini App for media requests, backed by the Seerr API
> Replaces: Doplarr (Discord)
> Version: 2.0

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Seerr API Contract](#3-seerr-api-contract)
4. [Data Models](#4-data-models)
5. [Mini App](#5-mini-app)
6. [Bot Commands](#6-bot-commands)
7. [Notifications](#7-notifications)
8. [Account Linking](#8-account-linking)
9. [Configuration](#10-configuration)
10. [Deployment](#11-deployment)

---

## 1. Overview

Teleseerr is a **Telegram Mini App** that sits in front of **Seerr** (a fork of Overseerr/Jellyseerr) and lets users browse, discover, and request movies and TV shows — all within Telegram.

### Core principle

> The Mini App is the UX. Browse, discover, request — no commands needed.

Users tap the bot's menu button → Mini App opens full-screen inside Telegram. They browse trending, search, filter by genre, view details, and request with a single tap. TV shows get season-level selection. The bot itself only handles `/start` (opens the Mini App) and sends DM notifications when request statuses change.

### Granularity

- **Movies**: One-tap request
- **TV Shows**: Season-level selection — request all missing, new/unaired only, or pick specific seasons
- **Anime**: Treated as TV — same season selection flow

---

## 2. Architecture

```
Telegram Client
     │
     │  (opens Mini App via menu button)
     ▼
┌─────────────────┐                      ┌─────────────────┐
│  Mini App       │  ── HTTP API ──────► │                 │
│  (web/app.js)   │  X-Telegram-Init-Data│  Teleseerr       │
│  served at      │ ◄─── JSON ──────────│  Server         │
│  teleseerr.example.com │                      │  (server.ts)    │
└─────────────────┘                      └────────┬────────┘
                                                  │
                                         X-Api-Key (all ops)
                                                  │
                                         ┌────────▼────────┐
                                         │   Seerr API     │
                                         │  :5055/api/v1   │
                                         └─────────────────┘

┌─────────────────┐
│  Teleseerr Bot   │  ◄── Seerr webhook POST ──
│  (index.ts)     │  ── Sends DM notifications ──►
│  /start command │
└─────────────────┘
```

### Auth model

- **Admin API key** — used for all Seerr operations: search, details, trending, requests, user management
- **Per-user attribution** — when creating requests, the linked user's Seerr user ID is passed via `userId` field so Seerr attributes the request correctly (respects quotas, auto-approve, history)
- **Unlinked users** — users who haven't been linked to a Seerr account are blocked from all API endpoints (except `/api/me`) and see a waiting screen until an admin links them

### Mini App authentication

All Mini App API calls include `X-Telegram-Init-Data` header. The server validates this via HMAC-SHA256 (Telegram Web App standard) and extracts the user's Telegram ID.

---

## 3. Seerr API Contract

### Authentication

```
X-Api-Key: <SEERR_API_KEY>
Content-Type: application/json
Base URL: http://<SEERR_HOST>:5055/api/v1
```

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/search?query=<str>&page=1` | GET | Search movies/TV/people |
| `/movie/:tmdbId` | GET | Movie details (runtime, genres, credits, videos, external IDs) |
| `/tv/:tmdbId` | GET | TV details (seasons, credits, content ratings, networks) |
| `/request` | POST | Create media request |
| `/request?take=N&skip=N&sort=added&requestedBy=N` | GET | List requests |
| `/user/:id/quota` | GET | User's request quota |
| `/user?take=N&skip=N` | GET | List all users (admin) |
| `/user/:id` | GET | Single user details |
| `/discover/trending?page=1` | GET | Trending content |
| `/discover/movies?page=1&genre=N` | GET | Discover movies (note: plural "movies") |
| `/discover/tv?page=1&genre=N` | GET | Discover TV shows |
| `/discover/genreslider/movie` | GET | Movie genre list |
| `/discover/genreslider/tv` | GET | TV genre list |
| `/service/radarr` | GET | Radarr services (4K detection) |
| `/service/sonarr` | GET | Sonarr services (4K/anime detection) |

### Key enums

**MediaStatus:** 1=Unknown, 2=Pending, 3=Processing, 4=PartiallyAvailable, 5=Available

**RequestStatus:** 1=Pending, 2=Approved, 3=Declined

---

## 4. Data Models

### Seerr Types (src/types.ts)

```typescript
type SearchResult = {
  id: number                    // TMDb ID
  mediaType: 'movie' | 'tv'
  title?: string                // movies
  name?: string                 // TV
  posterPath: string | null
  voteAverage: number
  mediaInfo: MediaInfo | null
}

type MovieDetails = SearchResult & {
  runtime: number | null
  genres: Genre[]
  tagline: string
  credits: { cast: CastMember[]; crew: CrewMember[] }
  relatedVideos: RelatedVideo[]
  externalIds: { imdbId?: string }
  releases?: { results: [...] }  // for certification
}

type TvDetails = SearchResult & {
  numberOfSeasons: number
  seasons: TvSeason[]
  genres: Genre[]
  credits: { cast: CastMember[]; crew: CrewMember[] }
  relatedVideos: RelatedVideo[]
  externalIds: { imdbId?: string }
  networks: Network[]
  episodeRunTime: number[]
  contentRatings?: { results: ContentRating[] }
  createdBy?: { id: number; name: string }[]
}

type AccountLink = {
  telegramUserId: number
  seerrUserId: number
  seerrUsername: string
  linkedAt: number
}
```

---

## 5. Mini App

### 5.1 Tabs

| Tab | Content | API |
|-----|---------|-----|
| **Trending** | Trending movies & TV with load-more | `GET /api/trending` |
| **Movies** | Genre chips + discover grid | `GET /api/genres/movie`, `GET /api/discover/movie` |
| **TV Shows** | Genre chips + discover grid | `GET /api/genres/tv`, `GET /api/discover/tv` |
| **My Requests** | User's request history with status | `GET /api/requests` |
| **Admin** (admin only) | Link/unlink users | `GET /api/admin/users`, etc. |

### 5.2 Init Flow

On load, the Mini App calls `GET /api/me` which returns:

```json
{
  "linked": true,
  "seerrUserId": 1,
  "seerrUsername": "karolis",
  "isAdmin": true,
  "telegramUserId": 123456
}
```

- If `linked: false` and not admin → show "waiting for captain" screen with Telegram ID
- If `isAdmin: true` → inject "Admin" tab

### 5.3 Detail View

Tapping any media card opens a detail view with:

- Backdrop image + poster
- Title, year, tagline
- Meta pills: rating, certification, runtime/seasons, network, status
- Genre tags
- Overview text
- Credits: director (movies), creators (TV), top 5 cast with characters
- External links: YouTube trailer, IMDB
- **Movies**: "Plunder It!" button (if requestable)
- **TV**: Season picker with quick actions

### 5.4 TV Season Picker

Seasons display as buttons with status indicators:
- `S1 ✅` — available (not tappable)
- `S2 ⏳` — pending/approved request (not tappable)
- `S3` — requestable (tappable, toggles selection)

Quick actions:
- **All Missing** — selects all requestable seasons
- **New Only** — selects future/unaired requestable seasons
- **Clear** — deselects all (appears when seasons are selected)

When seasons are selected, a sticky bottom bar shows "Plunder S1, S3, S5" button.

### 5.5 Profile View

Accessible via user icon in top-right. Shows:
- Seerr username and Telegram ID
- Request quota (movie and TV) with progress bars

### 5.6 Admin Panel

Admin-only tab with:
- **Linked users list**: shows all Telegram→Seerr mappings with unlink buttons
- **Link new user**: input Telegram ID, browse paginated Seerr users, tap to link

### 5.7 Mini App API Endpoints (server.ts)

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/me` | GET | initData | Current user state |
| `/api/trending` | GET | initData | Trending content |
| `/api/search` | GET | initData | Search media |
| `/api/movie/:id` | GET | initData | Movie details |
| `/api/tv/:id` | GET | initData | TV details |
| `/api/genres/:type` | GET | initData | Genre list |
| `/api/discover/:type` | GET | initData | Discover by genre |
| `/api/request` | POST | initData | Create request (rate-limited) |
| `/api/requests` | GET | initData | User's request history |
| `/api/quota` | GET | initData | User's quota |
| `/api/admin/users` | GET | initData + admin | All linked accounts |
| `/api/admin/seerr-users` | GET | initData + admin | Seerr users for linking |
| `/api/admin/link` | POST | initData + admin | Link user |
| `/api/admin/unlink` | POST | initData + admin | Unlink user |

---

## 6. Bot Commands

The bot is a thin shell. Only one command:

| Command | Description |
|---------|-------------|
| `/start` | Sends a WebApp button to open the Mini App |

The bot's **menu button** is set to open the Mini App directly via `setChatMenuButton` — users don't need to type any command.

---

## 7. Notifications

Notifications are delivered via **Seerr webhooks** — Seerr POSTs to the bot's webhook endpoint on status changes.

### Webhook Endpoint

`POST /webhook/<WEBHOOK_SECRET>` — secured by a secret token in the URL path (Seerr does not support HMAC signing).

### Seerr Webhook Configuration

In Seerr Settings → Notifications → Webhook, set:
- **URL:** `https://teleseerr.example.com/webhook/<your-secret>`
- **JSON Payload:**

```json
{
  "notification_type": "{{notification_type}}",
  "subject": "{{subject}}",
  "message": "{{message}}",
  "media": {
    "media_type": "{{media_type}}",
    "tmdbId": "{{media_tmdbid}}",
    "status": "{{media_status}}",
    "status4k": "{{media_status4k}}"
  },
  "request": {
    "request_id": "{{request_id}}",
    "requestedBy_username": "{{requestedBy_username}}",
    "requestedBy_email": "{{requestedBy_email}}"
  }
}
```

### Handled Notification Types

| Seerr Type | DM Message |
|---|---|
| `MEDIA_AVAILABLE` | ✅ Media became available |
| `MEDIA_APPROVED` / `MEDIA_AUTO_APPROVED` | ⚙️ Request approved (downloading) |
| `MEDIA_DECLINED` | 🔴 Request declined |
| `MEDIA_FAILED` | 🔴 Request failed |

Reverse lookup: Seerr username → Telegram user ID via account store.

---

## 8. Account Linking

### Flow

1. Admin opens Mini App → Admin tab
2. Enters the Telegram user ID of the person to link
3. Browses paginated Seerr users
4. Taps a Seerr user to create the link
5. Link is saved to `data/links.json`

### Auto-link

On startup, if `TELESEERR_ADMIN_SEERR_USER_ID` is set and admin isn't linked yet, the bot auto-links the admin to that Seerr user.

### Unlinked users

Unlinked users are blocked from all Mini App functionality. They see a waiting screen with their Telegram ID, which they share with the admin who links them via the Admin panel. All API endpoints (except `/api/me`) return 403 for unlinked users.

---

## 9. Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from BotFather |
| `SEERR_URL` | Yes | — | Seerr base URL |
| `SEERR_API_KEY` | Yes | — | Seerr admin API key |
| `TELESEERR_ADMIN_USER_ID` | Yes | — | Admin's Telegram user ID |
| `TELESEERR_ADMIN_SEERR_USER_ID` | No | 1 | Seerr user ID for auto-linking admin |
| `TELESEERR_MINI_APP_URL` | No | "" | Mini App public URL (enables Mini App) |
| `TELESEERR_MINI_APP_PORT` | No | 3000 | HTTP server port |
| `TELESEERR_WEBHOOK_SECRET` | No | "" | Secret token for Seerr webhook URL |
| `TELESEERR_DEFAULT_4K` | No | false | Default 4K preference |
| `TELESEERR_DATA_DIR` | No | ./data | Data directory |
| `TELESEERR_ANIME_SONARR_ID` | No | — | Seerr service ID for dedicated anime Sonarr |
| `LOG_LEVEL` | No | info | Pino log level |

---

## 10. Deployment

### Docker

```yaml
services:
  teleseerr:
    build: .
    container_name: teleseerr
    environment:
      - TELESEERR_MINI_APP_URL=https://teleseerr.example.com
      - SEERR_URL=http://seerr:5055
    volumes:
      - ./teleseerr-data:/app/data
    networks:
      - default
      - arr_default
```

### Network

- Runs in `bots` stack at `/opt/stacks/bots/`
- Connected to `arr_default` network to reach Seerr
- Caddy proxies `teleseerr.example.com` → `teleseerr:3000` (no auth)
- Data persisted at `/opt/stacks/bots/teleseerr-data/`

### Reverse proxy (Caddy)

```
teleseerr.example.com {
    reverse_proxy teleseerr:3000
}
```
