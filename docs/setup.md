# Setup and operations

[← Back to Teleseerr](../README.md)

## Setup

### Prerequisites

- [Seerr](https://github.com/seerr-team/seerr) instance with an API key
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram user ID (get it from [@userinfobot](https://t.me/userinfobot))

### Environment variables

Copy `.env.example` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from BotFather |
| `SEERR_URL` | Yes | — | Seerr base URL (e.g. `http://seerr:5055`) |
| `SEERR_API_KEY` | Yes | — | Seerr admin API key |
| `TELESEERR_ADMIN_USER_ID` | Yes | — | Your Telegram user ID (message [@userinfobot](https://t.me/userinfobot) to get it) |
| `TELESEERR_ADMIN_SEERR_USER_ID` | No | `1` | Seerr user ID to auto-link admin on startup |
| `TELESEERR_MINI_APP_URL` | No | — | Public HTTPS URL where the Mini App is served |
| `TELESEERR_MINI_APP_PORT` | No | `3000` | HTTP server port |
| `TELESEERR_WEBHOOK_SECRET` | No | — | Secret for Seerr webhook URL (`openssl rand -hex 32`) |
| `TELESEERR_DEFAULT_4K` | No | `false` | Default 4K preference |
| `TELESEERR_ANIME_SONARR_ID` | No | — | Seerr service ID for a dedicated anime Sonarr |
| `TELESEERR_DATA_DIR` | No | `./data` | Data directory for JSON stores |

### Docker Compose (recommended)

```yaml
services:
  teleseerr:
    image: ghcr.io/nikamura/teleseerr:latest
    container_name: teleseerr
    environment:
      - TELEGRAM_BOT_TOKEN=${TELESEERR_TELEGRAM_BOT_TOKEN}
      - SEERR_URL=http://seerr:5055
      - SEERR_API_KEY=${TELESEERR_SEERR_API_KEY}
      - TELESEERR_ADMIN_USER_ID=${TELESEERR_ADMIN_USER_ID}
      - TELESEERR_MINI_APP_URL=https://teleseerr.example.com
      - TELESEERR_WEBHOOK_SECRET=${TELESEERR_WEBHOOK_SECRET}
    volumes:
      - ./teleseerr-data:/app/data
    networks:
      - default
      - arr_default
    restart: unless-stopped
```

The container needs network access to your Seerr instance.

> [!IMPORTANT]
> The Mini App opens inside Telegram’s WebView. For users to reach it, `TELESEERR_MINI_APP_URL` must be a **publicly accessible HTTPS URL**, not a local/private IP. You'll need a reverse proxy (Caddy, nginx, Traefik) with a valid TLS certificate, or a tunnel like [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

> [!NOTE]
> **Anime Sonarr** — If you have a dedicated anime Sonarr instance in Seerr, set `TELESEERR_ANIME_SONARR_ID` to its Seerr service ID. Anime requests will be automatically routed there based on TMDB keywords. Without this, all TV requests (including anime) go to the default Sonarr.

### Development

```bash
pnpm install
pnpm dev    # live reload with tsx watch
```

### Seerr webhook

To receive notifications when requests are approved/available, configure a webhook in Seerr:

**Settings → Notifications → Webhook:**
- URL: `https://your-domain/webhook/<your-secret>`
- See [SPEC.md](../SPEC.md) for the JSON payload template

## How it works

Users message the bot or tap the menu button to open the Mini App. New users are blocked until an admin links their Telegram account to a Seerr user. The admin gets a Telegram notification when someone new wants access and can link them from the admin panel in the Mini App.

All Seerr API calls use the admin API key, but requests are attributed to the linked Seerr user so per-user quotas and auto-approve rules are respected.

## Tech stack

- **Bot**: [grammY](https://grammy.dev/) (TypeScript)
- **Frontend**: Vanilla JS with [Telegram Web App SDK](https://core.telegram.org/bots/webapps)
- **Runtime**: Node.js 24
- **Data**: JSON files (no database)

### Automatic request retries

Set `TELESEERR_AUTO_RETRY_FAILED=true` to enable retries of failed requests using
Seerr's native retry endpoint. This requires `TELESEERR_MINI_APP_URL`, a
`TELESEERR_WEBHOOK_SECRET`, and Seerr configured to deliver `MEDIA_FAILED`
webhooks. Retries are disabled by default.

`TELESEERR_RETRY_DELAYS_SECONDS=30,120,300` configures up to ten recovery rounds,
with each delay between 1 and 86400 seconds. Each round first checks the current
request and account link; only requests still failed and owned by a linked user
are retried. Lookup outages consume a round too, so upstream failures cannot
cause unlimited background work. Requests that are deleted, declined or unlinked
stop automatically. Approved requests stop polling and can resume on a later
failure webhook using their remaining budget.

State is atomically saved to `TELESEERR_DATA_DIR/retries.json` (the existing data
volume). Restarts resume pending work without resetting consumed rounds. Run
only one Teleseerr process per data directory. Exhausted/cancelled records are
retained to prevent replay; at 10,000 records, new automatic retries fail closed
and log an error. Do not delete the ledger to resolve an outage: doing so resets
retry budgets. A corrupt ledger prevents startup with retries enabled; restore a
backup or disable retries while investigating. Manual retries remain available
in Seerr.

### Approval notifications and optional integrations

Approval means **queued for processing**, not necessarily downloading. Movie
approvals check the matching standard/4K Radarr when its URL and API key are
configured and Seerr has an unambiguous matching service. Otherwise release
metadata provides a conservative fallback; no download date is promised.
Configure direct URLs to match the corresponding Seerr instances.

Local and webhook approval messages share request-ID deduplication for 24 hours
(up to 10,000 recent events per process). Local confirmations remain enabled even
when a webhook secret is configured. Delivery failures can be retried by another
event; a process restart clears notification deduplication, but not retry budgets.

Compose now forwards webhook, anime routing, standard/4K Radarr/Sonarr and retry
settings. `TELESEERR_DOCKER_NETWORK` selects the external Docker network and
still defaults to `arr_default`. No host-control bind mount is required.

Run `pnpm test` for the retry and notification regression tests.

### Security controls and HTTP migration

Mini App credentials expire 24 hours after Telegram's signed `auth_date`. Reopen
the Mini App to obtain fresh credentials after expiry. The Login Widget retains
its 30-day lifetime. Both reject missing, invalid or more than 60-seconds-future
timestamps; neither policy prevents replay within its validity window.

Authenticated API requests (including `/api/me`) share a per-user burst of 20,
refilling at one request/second, with two concurrent requests per user and eight
across the process. The global burst is 60 and refills at three/second. Rejected
requests return 429 with Retry-After. Webhooks have a separate shared burst of ten,
refilling at one per two seconds, and at most two concurrent handlers. Limits are
process-local; retain upstream controls when running multiple instances.

Webhook event types and IDs are validated; current Seerr state must agree with
the event before notifications or retry cancellation. Titles are fetched from
Seerr, never trusted from webhook text. Keep the webhook secret private and rotate
it if exposed: state verification does not replace the secret. Delayed events
that conflict with current state are ignored. Availability requires completed
request state or available media in the request's standard/4K tier.

**Before upgrading an HTTP-only installation:** use HTTPS service URLs, or
explicitly set `TELESEERR_ALLOW_INSECURE_HTTP=true` only for a trusted, isolated
private network. HTTP is rejected by default for Seerr and all optional Arr URLs;
the opt-in does not encrypt traffic. Compose forwards this flag with a default of
false, so its built-in `http://seerr:5055` requires this deliberate choice or an
HTTPS `SEERR_URL` override. Never enable it for an untrusted network. Service URLs
cannot contain embedded credentials, queries or fragments, and authenticated
service requests refuse redirects to prevent forwarding API keys elsewhere.

### Shared download recovery (pilot)

Title pages automatically show library status. Series pages list episodes by
season, with available, missing, unaired, and transfer states. All linked users
can view status. Permitted users can choose **Find releases** for an aired,
monitored missing episode, or **Find alternatives** for an existing transfer. Request ownership is
not required. In **Admin → Linked Users**, enable **Manage downloads** for trusted
users when ready. Existing users default to disabled; the configured administrator
always has access. Revocation takes effect on the next server request, including
selections already open in the Mini App. Reopen the app after granting access.

The pilot uses configured standard/4K Radarr and Sonarr instances and supports
existing movie, episode, and shared season transfers, plus missing monitored
episodes in an existing Sonarr series. It does not add new titles or requests,
expose arbitrary torrent URLs, override non-queue release rejections,
or configure a separate anime instance automatically. Reported seed counts do
not guarantee speed. Choices expire after two minutes; searches have a 30-second
per-user cooldown. Replacement affects everyone waiting for the shared title.

For a missing episode, the server verifies its series mapping, monitoring, air
date, file status and absence from the queue both before searching and before
grabbing. Only a release for that exact episode is selectable; season packs and
all Arr rejection reasons remain blocked. A missing-episode grab never removes
a transfer.

For replacements, the server grabs the new release first and requires a distinct replacement
transfer to become visible before removing the original through Arr. A failed or
ambiguous grab leaves the old transfer alone. Partial cleanup is reported to the
user for admin inspection; automatic mutation retries are deliberately avoided.
The original transfer is removed without blocklisting or triggering another
search. No completed library files are deleted. The download client's treatment
of partial files follows Arr's removal behavior.

`links.json` stores permissions. `download-switches.json` persists a two-minute
per-title switch cooldown before issuing a grab; `download-activity.jsonl` records
actor, service, queue ID, time, and outcome without indexer URLs or credentials.
Retain these in the existing data volume and run one process per data directory.
A damaged cooldown ledger fails closed. Activity log retention is operator-managed.

### Season recovery

In a series' Episodes section, users with **Manage downloads** can choose
**Download missing episodes** for a season. After confirmation, Teleseerr restores
series/season monitoring, monitors only missing aired episodes without transfers,
and queues an exact-episode Sonarr search. Available, unaired, unknown-air-date,
and already queued episodes are excluded; other seasons retain their settings.
Normal Maintainerr cleanup remains in effect. No retention exclusions are added.

The view refreshes while searching/downloading and distinguishes a queued search
from available episodes. Search completion does not guarantee a suitable release.
Search status associations last 30 minutes in the current process; Sonarr keeps
running accepted searches across Teleseerr restarts. The existing persistent
per-title two-minute cooldown and activity log also cover recovery. Ambiguous
failures report possible partial monitoring changes and require a fresh status
check. Season-pack selection and selective torrent file downloading are outside
this action; existing **Find alternatives** remains available for stuck transfers.

For individual recovery, **Download episode** appears beside each missing aired
episode for users with **Manage downloads**. It restores monitoring and searches
only that episode, including when it was previously unmonitored. This is direct
Sonarr recovery for shows already in the connected library, not a Seerr request:
it does not create a request record or use Seerr approval/quota tracking. Normal
season requests still go through Seerr. Other missing episodes remain untouched.

### Unified TV requests and episodes

TV titles use one **Seasons & episodes** section. Each row separates the Seerr
season request status (awaiting approval, approved request, failed/declined, or
no active request) from actual episode availability. Expand a season to select
it for the normal Seerr request flow or use permitted episode recovery actions.
The duplicate season grid has been removed. Season selection still uses the
request confirmation bar, including the existing 4K option. Standard and 4K
request labels follow their respective library tiers.

Season controls remain usable when direct Sonarr status is unconfigured or
unavailable. Episode recovery still requires Manage downloads and a show already
in Sonarr; monitoring alone is labelled as monitoring, not as a Seerr request.

### Troubleshooting and replacements

**Having trouble?** is available on title and episode screens. Linked users can
report download, playback, wrong-episode, audio, subtitle and other issues.
Reports include device, notes, file identity and a sanitized diagnostic snapshot;
only their owner and the configured administrator can read them. Requests →
Problems shows the user's reports; People → Reported problems is the admin queue.
Admins can investigate and post updates. Reports remain open until explicitly
resolved. A periodic two-minute checker notices newly imported file identities
and labels them **replacement available**, asking the user to test playback.
Updates are visible in the app; this does not send extra Telegram messages.

Manage downloads permits release search/replacement, targeted automatic import
retry, and torrent priority. It is independent of Seerr request approvals and
quotas. Revocation is checked on every mutation. Current files are retained while
a replacement downloads; Sonarr/Radarr own the eventual import and swap. No
library-file deletion or global quality-profile changes are performed here.

Available movies, individual episodes and complete seasons can be replaced.
Complete seasons require every episode to have a file and no active transfer;
this allows a multi-episode file to be handled together. Other selections fail
closed. Same-quality disk/cutoff conflicts can be ignored only when quality ID,
revision and custom-format score are verified not to regress. All unrelated
rejections and downloadAllowed=false remain blocking. Release labels advertise
languages; the explicit English filter is not a guarantee of imported audio.

Arr often redacts its stored client password. Set TELESEERR_QBITTORRENT_URL,
TELESEERR_QBITTORRENT_USERNAME and TELESEERR_QBITTORRENT_PASSWORD server-side.
The URL must exactly match the mapped Arr client before these credentials are used.
Connect Teleseerr to that client's authenticated Docker network (vpn_clients in
this installation), rather than a network with an authentication bypass.

qBittorrent is mapped through the configured Arr download client, never through
a user-supplied URL. Diagnostics show speed, peers and last activity when available.
Watch sooner moves just that shared hash to the top, requires queueing enabled,
verifies the resulting priority and has a persistent 30-minute cooldown. It never
pauses other transfers or enables global queueing. No peers still needs a source.
Refresh library status submits only a mapped RescanSeries/RescanMovie command,
with a five-minute cooldown. It does not forge Seerr availability or trigger a
global Plex scan. Seerr and Plex may need their next scan to catch up.

Import retry derives the completed transfer's path from Arr and submits only a
DownloadedEpisodesScan/DownloadedMoviesScan with Auto mode, with a five-minute
cooldown. It cannot fix storage permissions or a full disk.

Pending request editing and cancellation require ownership, current pending
status, confirmation, and the linked user's X-Api-User identity upstream. Failed
request retries require status FAILED (4). Approved shared requests are protected.
Season edits preserve the request's existing routing/profile settings.

Optional integrations (server-side configuration only):

- TELESEERR_MAINTAINERR_URL: read-only cleanup membership and eligibility dates.
  Full membership is used; enriched season metadata supplies exact season numbers.
  Normal cleanup policy is unchanged; dates indicate eligibility, not a guaranteed run.
- TELESEERR_PLEX_URL and TELESEERR_PLEX_TOKEN: active playback is filtered by both
  the linked Seerr plexId and this title's ratingKey. Other users' sessions, paths,
  tokens and server identifiers are never returned. File tracks come from Arr's
  imported-file scanner, separate from advertised release languages.
- TELESEERR_STATUS_URL: independently hosted HTTPS status page. The included
  Independent status GitHub workflow publishes to GitHub Pages after enabling
  workflow-based Pages and setting TELESEERR_PUBLIC_URL to the public health URL.
  Optional SEERR_PUBLIC_URL/PLEX_PUBLIC_URL repository variables can add public
  probes. Never put credentials in these URLs. Checks run about every 15 minutes;
  observations older than 45 minutes are shown as unknown. The probe measures
  public reachability, not user playback. Schedule delays are possible.

Diagnostics and reports redact private Arr messages into actionable categories.
Unavailable adapters are explicitly labelled. Subtitle issues offer verified
track information, player guidance and tracked reports; no global subtitle scan
or automatic codec/quality setting changes are triggered.

### Screen routes and GoatCounter

The app uses History API routes with the existing SPA fallback. Serve assets from
root paths, and preserve `/stats` handlers before the SPA fallback. Teleseerr's
`analytics-path-mode=screens` meta opts into the shared homelab loader's private
screen buckets. The proxy injects one tracker; do not add another count.js tag.
Analytics remains at `/stats/` behind the existing admin gate. Counting is
anonymous and aggregates title/person pages rather than sending their IDs.
