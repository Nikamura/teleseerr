import { wakeReportNotifications } from "../support-notifications.js";
import { playbackStatus } from "../arr/playback.js";
import { cleanupStatus } from "../arr/cleanup.js";
import { config } from "../config.js";
import { getInstances } from "../arr/client.js";
import { torrentClient } from "../arr/torrent.js";
import {
  arr,
  queue,
  findSeries,
  instanceByName,
  canManageDownloads,
  episodeState,
  type Episode,
} from "./downloads.js";
import { ClientError, json, parseJsonBody, type RouteContext } from "../http.js";
import * as store from "../support-store.js";
import * as seerr from "../seerr/client.js";
import { accountStore } from "../stores.js";

type Movie = { id: number; tmdbId: number; hasFile: boolean; movieFile?: File; monitored: boolean };
type File = {
  id: number;
  mediaInfo?: {
    audioLanguages?: string;
    subtitles?: string;
    audioCodec?: string;
    audioChannels?: number;
    videoCodec?: string;
    resolution?: string;
  };
};
const positive = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ClientError(400, "Invalid identifier");
  return n;
};
const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
export function safeProblem(value: string): string {
  // Arr messages may contain absolute paths, tracker URLs or client credentials.
  const lower = value.toLowerCase();
  if (/space|disk.*full/.test(lower))
    return "Storage is full. An administrator needs to free space.";
  if (/permission|access.*denied/.test(lower))
    return "The import service cannot access the file. Administrator action is needed.";
  if (/sample|not.*video|no.*video|executable/.test(lower))
    return "No suitable video file was found in this download.";
  if (/quality|upgrade|custom format/.test(lower))
    return "The downloaded release does not meet the library's quality or upgrade rules.";
  if (/match|episode|parse/.test(lower))
    return "The download could not be matched to the expected title or episode.";
  if (lower.includes("import"))
    return "Import needs attention. Retry once, then report it if it persists.";
  return "The download service reported a problem. An administrator can inspect its private log.";
}
export async function diagnosis(
  type: string,
  id: number,
  episodeId?: number,
  requestedInstance?: string,
) {
  if (type !== "movie" && type !== "tv") throw new ClientError(400, "Invalid title type");
  const instances = getInstances()[type === "tv" ? "sonarr" : "radarr"].filter(
    (i) => !requestedInstance || i.name === requestedInstance,
  );
  if (requestedInstance && !instances.length) throw new ClientError(400, "Unknown library");
  const results = await Promise.all(
    instances.map(async (instance) => {
      try {
        const series = type === "tv" ? await findSeries(instance, id) : undefined;
        const movie =
          type === "movie"
            ? (await arr<Movie[]>(instance, "movie")).find((m) => m.tmdbId === id)
            : undefined;
        const episodes = series
          ? (await arr<Episode[]>(instance, `episode?seriesId=${series.id}`)).filter(
              (e) => !episodeId || e.id === episodeId,
            )
          : [];
        if (episodeId && !episodes.length)
          throw new ClientError(404, "Episode not found in this library");
        const items = (await queue(instance)).filter((i) =>
          type === "tv"
            ? !!series && i.seriesId === series.id && (!episodeId || i.episodeId === episodeId)
            : !!movie && i.movieId === movie.id,
        );
        const files = series
          ? await arr<File[]>(instance, `episodefile?seriesId=${series.id}`)
          : movie?.movieFile
            ? [movie.movieFile]
            : [];
        const relevantFiles = files.filter(
          (f) => type === "movie" || episodes.some((e) => e.episodeFileId === f.id),
        );
        const seen = new Set<string>();
        const transfers = await Promise.all(
          items
            .filter((i) => {
              if (seen.has(i.downloadId)) return false;
              seen.add(i.downloadId);
              return true;
            })
            .slice(0, 20)
            .map(async (i) => {
              const info = await torrentClient(instance, i)
                .then((c) => c.info)
                .catch(() => null);
              const problems = [
                ...new Set(
                  (i.statusMessages ?? [])
                    .flatMap((m) => [m.title, ...m.messages])
                    .map(safeProblem),
                ),
              ];
              return {
                queueId: i.id,
                title: i.title,
                state: i.trackedDownloadState ?? i.status,
                remaining: i.sizeleft,
                importing: i.sizeleft === 0 && i.trackedDownloadState !== "imported",
                problems,
                speed: info?.dlspeed ?? null,
                seeds: info?.num_seeds ?? null,
                peers: info?.num_leechs ?? null,
                lastActivity: info?.last_activity
                  ? new Date(info.last_activity * 1000).toISOString()
                  : null,
                stalled: info ? /stalled|metaDL|error|missingFiles/.test(info.state) : null,
                canPrioritize: !!info && i.sizeleft > 0,
                canRetryImport:
                  !!i.outputPath &&
                  i.sizeleft === 0 &&
                  i.trackedDownloadState !== "imported" &&
                  i.trackedDownloadState !== "importing",
              };
            }),
        );
        return {
          instance: instance.name,
          reachable: true,
          inLibrary: !!series || !!movie,
          monitored: series?.monitored ?? movie?.monitored ?? false,
          files: relevantFiles.map((f) => ({
            id: f.id,
            audio: f.mediaInfo?.audioLanguages?.trim() ? f.mediaInfo.audioLanguages : "Unknown",
            subtitles: f.mediaInfo?.subtitles?.trim() ? f.mediaInfo.subtitles : "None detected",
            audioCodec: f.mediaInfo?.audioCodec ?? "Unknown",
            channels: f.mediaInfo?.audioChannels ?? null,
            videoCodec: f.mediaInfo?.videoCodec ?? "Unknown",
            resolution: f.mediaInfo?.resolution ?? "Unknown",
          })),
          episodes: episodes.map((e) => ({
            id: e.id,
            season: e.seasonNumber,
            episode: e.episodeNumber,
            state: episodeState(
              e,
              items.filter((i) => i.episodeId === e.id),
            ),
            monitored: e.monitored,
          })),
          transfers,
        };
      } catch {
        return {
          instance: instance.name,
          reachable: false,
          inLibrary: false,
          monitored: false,
          files: [],
          episodes: [],
          transfers: [],
        };
      }
    }),
  );
  const cleanup = await cleanupStatus(type, id);
  return {
    checkedAt: new Date().toISOString(),
    configured: instances.length > 0,
    libraries: results,
    cleanup: cleanup.items,
    cleanupAvailable: cleanup.available,
  };
}
export async function handleDiagnosis({ auth, res, params, url }: RouteContext): Promise<void> {
  const type = params["type"] ?? "";
  const id = positive(params["id"]);
  const episodeId = url.searchParams.has("episodeId")
    ? positive(url.searchParams.get("episodeId"))
    : undefined;
  const result = await diagnosis(
    type,
    id,
    episodeId,
    url.searchParams.get("instance") ?? undefined,
  );
  const details = await (type === "tv" ? seerr.getTvDetails(id) : seerr.getMovieDetails(id)).catch(
    () => null,
  );
  const requests = (details?.mediaInfo?.requests ?? [])
    .filter((r) => [1, 2, 4].includes(r.status))
    .map((r) => ({ status: r.status, seasons: r.seasons?.map((s) => s.seasonNumber) ?? [] }));
  store.markReplacement(
    auth.userId,
    type,
    id,
    episodeId,
    result.libraries.flatMap((l) => l.files.map((f) => `${l.instance}:${f.id}`)),
  );
  const account = accountStore.get(auth.userId);
  const playback = account ? await playbackStatus(account.seerrUserId, type, id) : null;
  json(res, {
    ...result,
    playback,
    requests,
    canManage: canManageDownloads(auth.userId),
    preferences: store.preferences(auth.userId),
  });
}
export async function handleReports({ auth, res, req }: RouteContext): Promise<void> {
  const admin = auth.userId === config.ADMIN_USER_ID;
  if (req.method === "GET") {
    json(res, { reports: store.reports(auth.userId, admin) });
    return;
  }
  const b = await parseJsonBody(req);
  if (b["id"]) {
    const status = b["status"];
    if (!["open", "investigating", "replacement_available", "resolved"].includes(String(status)))
      throw new ClientError(400, "Invalid report status");
    json(
      res,
      store.updateReport(
        text(b["id"], 100),
        auth.userId,
        admin,
        status as store.Report["status"],
        text(b["message"], 1000),
      ),
    );
    wakeReportNotifications();
    return;
  }
  const type = b["type"];
  if (type !== "movie" && type !== "tv") throw new ClientError(400, "Invalid title");
  if (!store.categories.includes(b["category"] as (typeof store.categories)[number]))
    throw new ClientError(400, "Select a problem");
  const tmdbId = positive(b["tmdbId"]);
  const episodeId = b["episodeId"] ? positive(b["episodeId"]) : undefined;
  const instance = text(b["instance"], 40) || undefined;
  const snapshot = await diagnosis(type, tmdbId, episodeId, instance);
  const episode = episodeId
    ? snapshot.libraries.flatMap((l) => l.episodes).find((e) => e.id === episodeId)
    : undefined;
  const details = await (
    type === "tv" ? seerr.getTvDetails(tmdbId) : seerr.getMovieDetails(tmdbId)
  ).catch(() => null);
  const title = details ? ("name" in details ? details.name : details.title) : `TMDB ${tmdbId}`;
  json(
    res,
    store.createReport({
      owner: auth.userId,
      type,
      tmdbId,
      ...(episodeId ? { episodeId } : {}),
      ...(episode ? { season: episode.season, episode: episode.episode } : {}),
      ...(instance ? { instance } : {}),
      category: String(b["category"]),
      title: title ?? `TMDB ${tmdbId}`,
      snapshot: {
        checkedAt: snapshot.checkedAt,
        services: snapshot.libraries.map((l) => ({
          instance: l.instance,
          reachable: l.reachable,
          monitored: l.monitored,
          problems: l.transfers.flatMap((t) => t.problems),
        })),
      },
      device: text(b["device"], 100),
      notes: text(b["notes"], 2000),
      fileIds: snapshot.libraries.flatMap((l) => l.files.map((f) => `${l.instance}:${f.id}`)),
    }),
    201,
  );
  wakeReportNotifications();
}
export async function handlePreferences({ auth, req, res }: RouteContext): Promise<void> {
  if (req.method === "GET") {
    json(res, store.preferences(auth.userId));
    return;
  }
  const b = await parseJsonBody(req);
  const audio = text(b["audio"], 30);
  const subtitles = text(b["subtitles"], 30);
  const languages = ["original", "eng", "lit", "rus", "jpn", "any", "none"];
  if (!languages.includes(audio) || !languages.includes(subtitles))
    throw new ClientError(400, "Select a supported language");
  json(res, store.preferences(auth.userId, { audio, subtitles }));
}
export async function handleSupportAction({ auth, req, res }: RouteContext): Promise<void> {
  if (!canManageDownloads(auth.userId))
    throw new ClientError(403, "Ask the admin for Manage downloads access in People");
  const b = await parseJsonBody(req);
  if (b["confirmed"] !== true) throw new ClientError(400, "Confirm this action");
  const instance = instanceByName(b["instance"]);
  if (b["action"] === "refresh-library") {
    const tmdbId = positive(b["tmdbId"]);
    const series = instance.type === "sonarr" ? await findSeries(instance, tmdbId) : undefined;
    const movie =
      instance.type === "radarr"
        ? (await arr<Movie[]>(instance, "movie")).find((m) => m.tmdbId === tmdbId)
        : undefined;
    if (!series && !movie)
      throw new ClientError(409, "Title mapping is unavailable. Refresh its request status first.");
    cooldownAction(auth.userId, `${instance.name}:${tmdbId}:refresh`, 300);
    await arr(
      instance,
      "command",
      "POST",
      series
        ? { name: "RescanSeries", seriesId: series.id }
        : { name: "RescanMovie", movieId: movie?.id },
    );
    json(res, {
      message:
        "Library refresh queued for this title. Reopen its status shortly. Plex and Seerr may need their next scan to reflect the result.",
    });
    return;
  }
  const item = (await queue(instance)).find((i) => i.id === positive(b["queueId"]));
  if (!item) throw new ClientError(409, "Transfer changed. Refresh first.");
  if (b["action"] === "priority") {
    if (item.sizeleft <= 0) throw new ClientError(409, "Transfer is already downloaded");
    const client = await torrentClient(instance, item);
    cooldownAction(auth.userId, `${instance.name}:${item.downloadId}:priority`, 1800);
    await client.prioritize();
    json(res, {
      message:
        "Moved this shared transfer to the top of the torrent queue. This cannot create missing peers or guarantee speed.",
    });
    return;
  }
  if (b["action"] === "retry-import") {
    if (
      !item.outputPath ||
      item.sizeleft !== 0 ||
      ["imported", "importing"].includes(item.trackedDownloadState ?? "")
    )
      throw new ClientError(409, "This transfer is not ready for an import retry");
    cooldownAction(auth.userId, `${instance.name}:${item.downloadId}:import`, 300);
    await arr(instance, "command", "POST", {
      name: instance.type === "sonarr" ? "DownloadedEpisodesScan" : "DownloadedMoviesScan",
      path: item.outputPath,
      downloadClientId: item.downloadId,
      importMode: "Auto",
    });
    json(res, {
      message:
        "Import retry queued for this transfer. Refresh to check the result; this does not confirm playback.",
    });
    return;
  }
  throw new ClientError(400, "Unknown action");
}
function cooldownAction(owner: number, key: string, seconds: number): void {
  store.cooldown(`user:${owner}:support`, 10);
  store.cooldown(key, seconds);
}
export async function handleRequestChange({ auth, req, res }: RouteContext): Promise<void> {
  const b = await parseJsonBody(req);
  const id = positive(b["id"]);
  const account = accountStore.get(auth.userId);
  const current = await seerr.getRequest(id);
  if (!account || current?.requestedBy.id !== account.seerrUserId)
    throw new ClientError(404, "Your request was not found");
  if (b["confirmed"] !== true) throw new ClientError(400, "Confirm the request change");
  const action = b["action"];
  if (action === "retry" && current.status === 4) {
    store.cooldown(`request:${id}`, 120);
    await seerr.retryRequest(id, account.seerrUserId);
    json(res, { message: "Request retry accepted. Check its status shortly." });
    return;
  }
  if (current.status !== 1 || (action !== "cancel" && action !== "edit"))
    throw new ClientError(
      409,
      "Only pending requests can be changed or cancelled. Approved shared downloads are protected.",
    );
  const seasons = b["seasons"];
  if (
    action === "edit" &&
    (current.type !== "tv" ||
      !Array.isArray(seasons) ||
      !seasons.length ||
      seasons.length > 100 ||
      seasons.some((n) => !Number.isInteger(n) || Number(n) < 0))
  )
    throw new ClientError(400, "Choose seasons for this pending TV request");
  if (action === "edit" && current.media) {
    const show = await seerr.getTvDetails(current.media.tmdbId);
    if ((seasons as number[]).some((n) => !show.seasons.some((s) => s.seasonNumber === n)))
      throw new ClientError(400, "Unknown season");
  }
  store.cooldown(`request:${id}`, 10);
  const response = await seerr.seerrFetch(`/request/${id}`, {
    method: action === "cancel" ? "DELETE" : "PUT",
    headers: { "X-Api-User": String(account.seerrUserId) },
    ...(action === "edit"
      ? {
          body: JSON.stringify({
            seasons,
            is4k: current.is4k,
            serverId: current.serverId,
            profileId: current.profileId,
            rootFolder: current.rootFolder,
            languageProfileId: current.languageProfileId,
            tags: current.tags,
          }),
        }
      : {}),
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new ClientError(409, "Request changed or Seerr rejected the change. Refresh first.");
  json(res, {
    message:
      action === "cancel"
        ? "Pending request cancelled. Shared downloads were not removed."
        : "Pending request updated.",
  });
}
export async function handleServiceStatus({ res }: RouteContext): Promise<void> {
  const instances = getInstances();
  const services = await Promise.all(
    [...instances.sonarr, ...instances.radarr].map(async (i) => ({
      name: i.name,
      available: await arr(i, "system/status")
        .then(() => true)
        .catch(() => false),
    })),
  );
  const seerrAvailable = await seerr
    .seerrFetch("/status")
    .then(async (r) => {
      await r.body?.cancel();
      return r.ok;
    })
    .catch(() => false);
  if (config.PLEX_URL) {
    const available = await fetch(`${config.PLEX_URL}/identity`, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    })
      .then(async (r) => {
        await r.body?.cancel();
        return r.ok;
      })
      .catch(() => false);
    services.push({ name: "Playback server", available });
  }
  json(res, {
    checkedAt: new Date().toISOString(),
    services: [{ name: "Requests", available: seerrAvailable }, ...services],
    externalStatusUrl: config.STATUS_URL.startsWith("https://") ? config.STATUS_URL : null,
    scope: "Server reachability. This does not test playback on your device.",
  });
}
