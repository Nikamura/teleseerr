import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { accountStore } from "../stores.js";
import { ClientError, json, parseJsonBody, type RouteContext } from "../http.js";
import { getInstances, type ArrInstance } from "../arr/client.js";
import * as seerr from "../seerr/client.js";

export type QueueItem = {
  id: number;
  downloadId: string;
  movieId?: number;
  downloadClientId?: number;
  outputPath?: string;
  statusMessages?: { title: string; messages: string[] }[];
  seriesId?: number;
  episodeId?: number;
  episodeFileId?: number;
  existingQuality?:
    | {
        quality?: { id?: number };
        revision?: { version?: number; real?: number; isRepack?: boolean };
      }
    | undefined;
  existingScore?: number | undefined;
  title: string;
  size: number;
  sizeleft: number;
  timeleft?: string;
  status: string;
  trackedDownloadState?: string;
  movie?: { tmdbId: number };
  series?: { tmdbId?: number; tvdbId?: number };
  episode?: { seasonNumber: number; episodeNumber: number };
};
type Release = {
  guid: string;
  indexerId: number;
  title: string;
  size: number;
  seeders?: number;
  protocol: string;
  rejected?: boolean;
  downloadAllowed?: boolean;
  rejections?: string[];
  quality?: {
    quality?: { name?: string; id?: number };
    revision?: { version?: number; real?: number; isRepack?: boolean };
  };
  customFormatScore?: number;
  languages?: { name: string }[];
  fullSeason?: boolean;
  seasonNumber?: number;
  episodeNumbers?: number[];
  infoHash?: string;
};
export type Episode = {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDateUtc?: string;
  hasFile: boolean;
  episodeFileId?: number;
  monitored: boolean;
};
type Series = { id: number; tmdbId?: number; tvdbId?: number; monitored: boolean };
type MissingTarget = {
  tmdbId: number;
  episodeId: number;
  episodeIds?: number[];
  replaceExisting?: boolean;
};
type Selection = {
  user: number;
  instance: ArrInstance;
  group: QueueItem[];
  releases: Release[];
  expires: number;
  missing?: MissingTarget;
};
const selections = new Map<string, Selection>();
const busy = new Set<string>();
const lastSearch = new Map<number, number>();
const ledgerPath = join(config.DATA_DIR, "download-switches.json");
function ledger(): Record<string, number> {
  // A damaged ledger must fail closed rather than reset mutation cooldowns.
  if (!existsSync(ledgerPath)) return {};
  const value: unknown = JSON.parse(readFileSync(ledgerPath, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== "number")
  )
    throw new Error("Invalid download switch ledger");
  return value as Record<string, number>;
}
function reserve(key: string): void {
  const times = ledger();
  if (Date.now() - (times[key] ?? 0) < 120_000)
    throw new ClientError(
      409,
      "A download action was recently attempted. Refresh and wait two minutes before trying again.",
    );
  mkdirSync(config.DATA_DIR, { recursive: true });
  const next = Object.fromEntries(
    Object.entries(times).filter(([, time]) => Date.now() - time < 120_000),
  );
  next[key] = Date.now();
  writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(next), { mode: 0o600 });
  renameSync(`${ledgerPath}.tmp`, ledgerPath);
}
function audit(
  user: number,
  instance: string,
  queueId: number,
  event: string,
  episodeId?: number,
): void {
  mkdirSync(config.DATA_DIR, { recursive: true });
  appendFileSync(
    join(config.DATA_DIR, "download-activity.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), user, instance, queueId, episodeId, event }) +
      "\n",
    { mode: 0o600 },
  );
}
export function canManageDownloads(userId: number): boolean {
  return userId === config.ADMIN_USER_ID || accountStore.get(userId)?.manageDownloads === true;
}
function authorize(userId: number): void {
  if (!canManageDownloads(userId))
    throw new ClientError(403, "Download management permission required");
}
export async function arr<T>(
  instance: ArrInstance,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${instance.url}/api/v3/${path}`, {
    method,
    headers: { "X-Api-Key": instance.apiKey, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(method === "GET" && path.startsWith("release?") ? 90_000 : 15_000),
  });
  if (!response.ok)
    throw new ClientError(
      502,
      `Download service returned ${response.status}. Refresh status before retrying.`,
    );
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
export async function queue(instance: ArrInstance): Promise<QueueItem[]> {
  const result: QueueItem[] = [];
  for (let page = 1; page <= 100; page++) {
    const data = await arr<{ records: QueueItem[]; totalRecords: number }>(
      instance,
      `queue?page=${page}&pageSize=100&includeMovie=true&includeSeries=true&includeEpisode=true`,
    );
    result.push(...data.records);
    if (result.length >= data.totalRecords) return result;
    if (!data.records.length) break;
  }
  throw new ClientError(502, "Download queue is incomplete; try again later");
}
function editable(item: QueueItem): boolean {
  return (
    !!item.downloadId &&
    item.sizeleft > 0 &&
    !["importPending", "importing", "imported", "ignored"].includes(item.trackedDownloadState ?? "")
  );
}
export function instanceByName(name: unknown): ArrInstance {
  const instances = getInstances();
  const instance = [...instances.radarr, ...instances.sonarr].find((i) => i.name === name);
  if (!instance) throw new ClientError(400, "Unknown download service");
  return instance;
}
function groupFor(items: QueueItem[], id: unknown): QueueItem[] {
  const item = items.find((i) => i.id === id);
  if (!item || !editable(item))
    throw new ClientError(409, "This download has changed or finished. Refresh its status.");
  const group = items.filter((i) => i.downloadId === item.downloadId);
  if (group.some((i) => !editable(i) || i.movieId !== item.movieId || i.seriesId !== item.seriesId))
    throw new ClientError(409, "This transfer cannot be safely replaced here");
  return group;
}
function firstItem(group: QueueItem[]): QueueItem {
  const first = group[0];
  if (!first) throw new ClientError(409, "Download no longer exists");
  return first;
}
function scopeKey(instance: ArrInstance, group: QueueItem[]): string {
  return `${instance.name}:${firstItem(group).movieId ?? firstItem(group).seriesId}`;
}
export function releaseProblems(
  release: Release,
  group: QueueItem[],
  allowQueueConflicts = true,
  replaceFile = false,
): string[] {
  const sameQuality =
    replaceFile &&
    group.every(
      (i) =>
        Number.isInteger(i.existingQuality?.quality?.id) &&
        i.existingQuality?.quality?.id === release.quality?.quality?.id &&
        Number.isFinite(i.existingScore) &&
        Number.isFinite(release.customFormatScore) &&
        Number(release.customFormatScore) >= Number(i.existingScore) &&
        (release.quality?.revision?.version ?? 0) >= (i.existingQuality?.revision?.version ?? 0) &&
        (release.quality?.revision?.real ?? 0) >= (i.existingQuality?.revision?.real ?? 0) &&
        (!i.existingQuality?.revision?.isRepack || !!release.quality?.revision?.isRepack),
    );
  const reasons = [...(release.rejections ?? [])].filter(
    (reason) =>
      !(
        sameQuality &&
        /^(?:Existing file (?:on disk )?(?:meets (?:quality |Custom Format )?cutoff:|on disk is of equal or higher (?:preference|revision):|on disk has a equal or higher Custom Format score:|on disk has Custom Format score within Custom Format score increment:|on disk and Quality Profile .* does not allow upgrades$))/.test(
          reason,
        )
      ) &&
      (!allowQueueConflicts ||
        !/^(?:Quality for release in queue already meets cutoff:|Release in queue (?:already meets cutoff:|is of equal or higher (?:preference|revision):|meets (?:quality|Custom Format) cutoff:|has (?:an equal or higher Custom Format score:|Custom Format score within Custom Format score increment:)|and Quality Profile '.+' does not allow upgrades$))/.test(
          reason,
        )),
  );
  if (release.protocol !== "torrent") reasons.push("Only torrent downloads are supported");
  if (!release.guid || !Number.isSafeInteger(release.indexerId))
    reasons.push("Release identity unavailable");
  if (release.downloadAllowed === false) reasons.push("Download not allowed by the service");
  if (release.rejected && !release.rejections?.length)
    reasons.push("Release rejected by the service");
  if (
    release.infoHash?.toLowerCase() === group[0]?.downloadId.toLowerCase() ||
    release.title === group[0]?.title
  )
    reasons.push("Already downloading this release");
  if (group[0]?.seriesId) {
    const seasons = new Set(group.map((i) => i.episode?.seasonNumber));
    const episodes = new Set(group.map((i) => i.episode?.episodeNumber));
    if (seasons.size !== 1 || seasons.has(undefined) || !seasons.has(release.seasonNumber))
      reasons.push("Season does not match");
    if (group.length > 1) {
      // Never replace a multi-episode transfer with only one of its episodes.
      if (!release.fullSeason) reasons.push("A season pack is required for this shared transfer");
    } else if (
      release.fullSeason ||
      release.episodeNumbers?.length !== 1 ||
      !episodes.has(release.episodeNumbers[0])
    ) {
      reasons.push("Release must contain exactly the selected episode");
    }
  }
  return reasons;
}
export async function findSeries(
  instance: ArrInstance,
  tmdbId: number,
): Promise<Series | undefined> {
  const tv = await seerr.getTvDetails(tmdbId);
  const series = await arr<Series[]>(instance, "series");
  const matches = series.filter(
    (s) =>
      s.tmdbId === tmdbId ||
      ((!s.tmdbId || s.tmdbId === tmdbId) &&
        !!tv.externalIds.tvdbId &&
        s.tvdbId === tv.externalIds.tvdbId),
  );
  if (matches.length > 1) throw new ClientError(409, "Series mapping is ambiguous");
  return matches[0];
}
export function episodeState(episode: Episode, transfers: QueueItem[], now = Date.now()): string {
  if (episode.hasFile) return "available";
  if (transfers.length) {
    if (
      transfers.some(
        (i) =>
          ["importPending", "importing"].includes(i.trackedDownloadState ?? "") || i.sizeleft === 0,
      )
    )
      return "importing";
    if (transfers.some((i) => i.status === "failed" || i.trackedDownloadState === "failedPending"))
      return "failed";
    if (transfers.some((i) => i.status === "paused")) return "paused";
    if (transfers.some((i) => i.status === "queued")) return "queued";
    if (transfers.some((i) => i.status === "warning")) return "attention";
    return "downloading";
  }
  const airTime = Date.parse(episode.airDateUtc ?? "");
  if (!Number.isFinite(airTime)) return "unknown";
  if (airTime > now) return "unaired";
  return "missing";
}
async function missingGroup(instance: ArrInstance, target: MissingTarget): Promise<QueueItem[]> {
  if (instance.type === "radarr") {
    if (!Number.isSafeInteger(target.tmdbId) || target.tmdbId <= 0 || !target.replaceExisting)
      throw new ClientError(400, "Invalid movie replacement");
    const movies = await arr<
      {
        id: number;
        tmdbId: number;
        hasFile: boolean;
        movieFile?: {
          id: number;
          sceneName?: string;
          quality?: QueueItem["existingQuality"];
          customFormatScore?: number;
        };
      }[]
    >(instance, "movie");
    const matches = movies.filter((m) => m.tmdbId === target.tmdbId);
    const movie = matches[0];
    if (matches.length !== 1 || !movie?.hasFile || !movie.movieFile?.id)
      throw new ClientError(409, "Installed movie file could not be mapped");
    if (
      (await queue(instance)).some(
        (i) =>
          i.movieId === movie.id &&
          (editable(i) || ["importPending", "importing"].includes(i.trackedDownloadState ?? "")),
      )
    )
      throw new ClientError(
        409,
        "A movie transfer is already active. Use its alternatives or wait for import.",
      );
    return [
      {
        id: 0,
        downloadId: "",
        movieId: movie.id,
        episodeFileId: movie.movieFile.id,
        title: movie.movieFile.sceneName ?? "",
        size: 0,
        sizeleft: 0,
        status: "available",
        existingQuality: movie.movieFile.quality,
        existingScore: movie.movieFile.customFormatScore,
      },
    ];
  }
  if (target.episodeIds) {
    const ids = [...new Set(target.episodeIds)];
    if (
      !target.replaceExisting ||
      ids.length < 2 ||
      ids.length > 100 ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
      throw new ClientError(400, "Select a complete season to replace");
    const series = await findSeries(instance, target.tmdbId);
    if (!series) throw new ClientError(409, "Series unavailable");
    const episodes = await arr<Episode[]>(instance, `episode?seriesId=${series.id}`);
    const selected = episodes.filter((e) => ids.includes(e.id));
    const season = selected[0]?.seasonNumber;
    if (
      selected.length !== ids.length ||
      selected.some((e) => e.seasonNumber !== season || !e.hasFile) ||
      episodes.some((e) => e.seasonNumber === season && !ids.includes(e.id))
    )
      throw new ClientError(
        409,
        "Season replacement requires every episode in one complete season",
      );
    const transfers = await queue(instance);
    if (
      transfers.some(
        (i) =>
          i.seriesId === series.id &&
          ids.includes(i.episodeId ?? -1) &&
          (editable(i) || ["importPending", "importing"].includes(i.trackedDownloadState ?? "")),
      )
    )
      throw new ClientError(
        409,
        "Season has an active transfer. Wait for it or use its alternatives.",
      );
    const files = await arr<
      {
        id: number;
        seriesId: number;
        sceneName?: string;
        quality?: QueueItem["existingQuality"];
        customFormatScore?: number;
      }[]
    >(instance, `episodefile?seriesId=${series.id}`);
    return selected.map((e) => {
      const file = files.find((f) => f.id === e.episodeFileId && f.seriesId === series.id);
      if (
        !file ||
        episodes.some((other) => other.episodeFileId === file.id && !ids.includes(other.id))
      )
        throw new ClientError(409, "File mapping changed or spans another season");
      return {
        id: 0,
        downloadId: "",
        title: file.sceneName ?? "",
        size: 0,
        sizeleft: 0,
        status: "available",
        seriesId: series.id,
        episodeId: e.id,
        episodeFileId: file.id,
        episode: { seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber },
        existingQuality: file.quality,
        existingScore: file.customFormatScore,
      };
    });
  }
  if (
    !Number.isSafeInteger(target.tmdbId) ||
    target.tmdbId <= 0 ||
    !Number.isSafeInteger(target.episodeId) ||
    target.episodeId <= 0
  )
    throw new ClientError(400, "Invalid episode target");
  const series = await findSeries(instance, target.tmdbId);
  if (!series || (!target.replaceExisting && !series.monitored))
    throw new ClientError(409, "Series is not monitored in the library");
  const episode = await arr<Episode>(instance, `episode/${target.episodeId}`);
  if (episode.seriesId !== series.id)
    throw new ClientError(400, "Episode does not belong to this series");
  const transfers = (await queue(instance)).filter(
    (i) => i.seriesId === series.id && i.episodeId === episode.id,
  );
  let currentTitle = "";
  let existingQuality: QueueItem["existingQuality"];
  let existingScore: number | undefined;
  if (target.replaceExisting) {
    if (
      !episode.hasFile ||
      !Number.isSafeInteger(episode.episodeFileId) ||
      Number(episode.episodeFileId) <= 0
    )
      throw new ClientError(409, "Episode file has changed or is unavailable. Refresh episodes.");
    if (
      transfers.some(
        (i) => editable(i) || ["importPending", "importing"].includes(i.trackedDownloadState ?? ""),
      )
    )
      throw new ClientError(
        409,
        "An episode transfer is already active. Use Find alternatives or wait for import.",
      );
    const episodes = await arr<Episode[]>(instance, `episode?seriesId=${series.id}`);
    if (episodes.some((e) => e.id !== episode.id && e.episodeFileId === episode.episodeFileId))
      throw new ClientError(
        409,
        "This file contains multiple episodes. Ask the admin to replace it in Sonarr.",
      );
    const file = await arr<{
      id: number;
      seriesId: number;
      sceneName?: string;
      quality?: QueueItem["existingQuality"];
      customFormatScore?: number;
    }>(instance, `episodefile/${episode.episodeFileId}`);
    if (file.id !== episode.episodeFileId || file.seriesId !== series.id)
      throw new ClientError(409, "Episode file mapping is ambiguous");
    currentTitle = file.sceneName ?? "";
    existingQuality = file.quality;
    existingScore = file.customFormatScore;
  } else if (!episode.monitored || episodeState(episode, transfers) !== "missing")
    throw new ClientError(
      409,
      "Episode is no longer missing, is not monitored, or has not aired. Refresh episodes.",
    );
  return [
    {
      id: 0,
      downloadId: "",
      title: currentTitle,
      existingQuality,
      existingScore,
      ...(target.replaceExisting ? { episodeFileId: episode.episodeFileId } : {}),
      size: 0,
      sizeleft: 0,
      status: "missing",
      seriesId: series.id,
      episodeId: episode.id,
      episode: { seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber },
    },
  ];
}
// Sonarr owns command execution; this cache only connects its status to the title view.
const seasonSearches = new Map<string, { id: number; at: number }>();
export async function handleSeasonRecovery({ auth, req, res }: RouteContext): Promise<void> {
  authorize(auth.userId);
  const body = await parseJsonBody(req);
  const instance = instanceByName(body["instance"]);
  const tmdbId = body["tmdbId"],
    season = body["season"];
  const episodeId = body["episodeId"];
  if (
    typeof tmdbId !== "number" ||
    !Number.isSafeInteger(tmdbId) ||
    tmdbId <= 0 ||
    typeof season !== "number" ||
    !Number.isSafeInteger(season) ||
    season < 0 ||
    (episodeId !== undefined &&
      (typeof episodeId !== "number" || !Number.isSafeInteger(episodeId) || episodeId <= 0)) ||
    body["confirmed"] !== true
  )
    throw new ClientError(400, "Choose a season and confirm recovery");
  const series = await findSeries(instance, tmdbId);
  if (!series) throw new ClientError(409, "Series is not in the connected library");
  const key = `${instance.name}:${series.id}`;
  if (busy.has(key)) throw new ClientError(409, "Another download action is in progress");
  busy.add(key);
  try {
    const episodes = await arr<Episode[]>(instance, `episode?seriesId=${series.id}`);
    const items = await queue(instance);
    const targets = episodes.filter(
      (e) =>
        e.seriesId === series.id &&
        e.seasonNumber === season &&
        (episodeId === undefined || e.id === episodeId) &&
        episodeState(
          e,
          items.filter((i) => i.seriesId === series.id && i.episodeId === e.id),
        ) === "missing",
    );
    if (!targets.length)
      throw new ClientError(409, "No missing aired episodes to recover. Refresh episodes.");
    const searchKey = `${key}:${season}`;
    const previous = seasonSearches.get(searchKey);
    if (previous && Date.now() - previous.at < 1_800_000) {
      const command = await arr<{ status: string }>(instance, `command/${previous.id}`);
      if (["queued", "started"].includes(command.status))
        throw new ClientError(409, "A search for this season is already running");
    }
    authorize(auth.userId);
    reserve(key);
    audit(auth.userId, instance.name, 0, `season_${season}_recovery_attempted`);
    try {
      // Unlike PUT series, null monitoringOptions preserves episode flags.
      await arr(instance, "seasonpass", "POST", {
        series: [
          { id: series.id, monitored: true, seasons: [{ seasonNumber: season, monitored: true }] },
        ],
      });
      await arr(instance, "episode/monitor", "PUT", {
        episodeIds: targets.map((e) => e.id),
        monitored: true,
      });
      // Recheck after monitoring: imports and existing transfers must not be searched again.
      const fresh = await arr<Episode[]>(instance, `episode?seriesId=${series.id}`);
      const transfers = await queue(instance);
      const ids = fresh
        .filter(
          (e) =>
            targets.some((t) => t.id === e.id) &&
            e.seriesId === series.id &&
            e.seasonNumber === season &&
            e.monitored &&
            episodeState(
              e,
              transfers.filter((i) => i.seriesId === series.id && i.episodeId === e.id),
            ) === "missing",
        )
        .map((e) => e.id);
      authorize(auth.userId);
      if (!ids.length) {
        json(res, {
          success: true,
          count: 0,
          message: "Monitoring restored. Episodes are already available or queued.",
        });
        return;
      }
      const command = await arr<{ id: number }>(instance, "command", "POST", {
        name: "EpisodeSearch",
        episodeIds: ids,
      });
      if (!Number.isSafeInteger(command.id) || command.id <= 0)
        throw new Error("Missing command identity");
      for (const [k, v] of seasonSearches)
        if (Date.now() - v.at > 1_800_000) seasonSearches.delete(k);
      seasonSearches.set(searchKey, { id: command.id, at: Date.now() });
      audit(auth.userId, instance.name, 0, `season_${season}_search_accepted`);
      json(res, {
        success: true,
        count: ids.length,
        message: `Search queued for ${ids.length === 1 ? "1 missing episode" : `${ids.length} missing episodes`}. Downloads will appear when a suitable release is found.`,
      });
    } catch {
      audit(auth.userId, instance.name, 0, `season_${season}_recovery_unconfirmed`);
      throw new ClientError(
        502,
        "Recovery could not be confirmed. Monitoring may have changed or a search may be running. Refresh status before retrying.",
      );
    }
  } finally {
    busy.delete(key);
  }
}
export async function handleDownloads({ auth, params, res }: RouteContext): Promise<void> {
  const id = Number(params["id"]),
    type = params["type"];
  if (!Number.isSafeInteger(id) || id <= 0 || !["movie", "tv"].includes(type ?? ""))
    throw new ClientError(400, "Invalid title");
  const instances = getInstances()[type === "movie" ? "radarr" : "sonarr"];
  const canManage = canManageDownloads(auth.userId);
  const results = await Promise.all(
    instances.map(async (instance) => {
      const series = type === "tv" ? await findSeries(instance, id) : undefined;
      const movie =
        type === "movie"
          ? (await arr<{ id: number; tmdbId: number; hasFile: boolean }[]>(instance, "movie")).find(
              (m) => m.tmdbId === id,
            )
          : undefined;
      const items = await queue(instance);
      const matched = items.filter((i) =>
        type === "movie" ? i.movie?.tmdbId === id : !!series && i.seriesId === series.id,
      );
      const episodes = series
        ? await arr<Episode[]>(instance, `episode?seriesId=${series.id}`)
        : [];
      const searches = [];
      for (const [key, value] of seasonSearches) {
        if (Date.now() - value.at > 1_800_000) {
          seasonSearches.delete(key);
          continue;
        }
        if (!series || !key.startsWith(`${instance.name}:${series.id}:`)) continue;
        const command = await arr<{ status: string }>(instance, `command/${value.id}`).catch(
          () => ({ status: "unknown" }),
        );
        searches.push({ season: Number(key.split(":").at(-1)), status: command.status });
      }
      const seen = new Set<string>();
      return {
        instance: instance.name,
        inLibrary: !!series || !!movie,
        canReplaceMovie:
          canManage &&
          !!movie?.hasFile &&
          !matched.some(
            (i) =>
              editable(i) || ["importPending", "importing"].includes(i.trackedDownloadState ?? ""),
          ),
        searches,
        episodes: episodes
          .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
          .map((episode) => {
            const transfers = matched.filter((i) => i.episodeId === episode.id);
            const state = episodeState(episode, transfers);
            const transfer = transfers.find(editable);
            const percent =
              transfers[0] && transfers[0].size > 0
                ? Math.max(
                    0,
                    Math.min(
                      100,
                      Math.round(
                        ((transfers[0].size - transfers[0].sizeleft) / transfers[0].size) * 100,
                      ),
                    ),
                  )
                : undefined;
            return {
              id: episode.id,
              season: episode.seasonNumber,
              episode: episode.episodeNumber,
              title: episode.title,
              airDate: episode.airDateUtc ?? null,
              state,
              percent,
              monitored: !!series?.monitored && episode.monitored,
              canReplaceFile:
                canManage &&
                state === "available" &&
                Number(episode.episodeFileId) > 0 &&
                !transfers.some(
                  (i) =>
                    editable(i) ||
                    ["importPending", "importing"].includes(i.trackedDownloadState ?? ""),
                ),
              canSearch:
                canManage &&
                ((state === "missing" && !!series?.monitored && episode.monitored) || !!transfer),
              ...(transfer ? { queueId: transfer.id } : {}),
            };
          }),
        items: matched
          .filter((i) => {
            if (!i.downloadId || seen.has(i.downloadId)) return false;
            seen.add(i.downloadId);
            return true;
          })
          .map((i) => ({
            instance: instance.name,
            queueId: i.id,
            title: i.title,
            status: i.status,
            eta: i.timeleft ?? null,
            percent:
              i.size > 0
                ? Math.max(0, Math.min(100, Math.round(((i.size - i.sizeleft) / i.size) * 100)))
                : 0,
            episodes: items
              .filter((other) => other.downloadId === i.downloadId)
              .map((other) => other.episode)
              .filter(Boolean),
            canReplace: canManage && editable(i),
          })),
      };
    }),
  );
  json(res, {
    configured: instances.length > 0,
    items: results.flatMap((r) => r.items),
    libraries: results.map(({ instance, inLibrary, episodes, searches, canReplaceMovie }) => ({
      instance,
      inLibrary,
      episodes,
      searches,
      canReplaceMovie,
    })),
    canManage,
    updatedAt: Date.now(),
  });
}
export async function handleReleaseSearch({ auth, req, res }: RouteContext): Promise<void> {
  authorize(auth.userId);
  if (Date.now() - (lastSearch.get(auth.userId) ?? 0) < 30_000)
    throw new ClientError(429, "Wait 30 seconds between release searches");
  const body = await parseJsonBody(req);
  const instance = instanceByName(body["instance"]);
  lastSearch.set(auth.userId, Date.now());
  for (const [id, value] of selections) if (value.expires < Date.now()) selections.delete(id);
  if (selections.size >= 100) throw new ClientError(429, "Too many active searches");
  const missing =
    body["queueId"] === undefined
      ? {
          tmdbId: Number(body["tmdbId"]),
          episodeId: Number(body["episodeId"]),
          ...(Array.isArray(body["episodeIds"])
            ? { episodeIds: body["episodeIds"] as number[] }
            : {}),
          replaceExisting: body["replaceExisting"] === true,
        }
      : undefined;
  const group = missing
    ? await missingGroup(instance, missing)
    : groupFor(await queue(instance), body["queueId"]);
  const first = firstItem(group);
  const query =
    instance.type === "radarr"
      ? `movieId=${first.movieId}`
      : group.length > 1
        ? `seriesId=${first.seriesId}&seasonNumber=${first.episode?.seasonNumber}`
        : `episodeId=${first.episodeId}`;
  if (
    (instance.type === "radarr" && !first.movieId) ||
    (instance.type === "sonarr" && (!first.seriesId || !first.episodeId || !first.episode))
  )
    throw new ClientError(409, "Download metadata is incomplete");
  if (body["audio"] !== undefined && body["audio"] !== "eng")
    throw new ClientError(400, "Unsupported release language filter");
  const releases = (await arr<Release[]>(instance, `release?${query}`))
    .slice(0, 300)
    .filter(
      (r) =>
        body["audio"] !== "eng" || r.languages?.some((l) => /^(?:english|eng|en)$/i.test(l.name)),
    );
  authorize(auth.userId);
  const token = randomUUID();
  selections.set(token, {
    user: auth.userId,
    instance,
    group,
    releases,
    expires: Date.now() + 120_000,
    ...(missing ? { missing } : {}),
  });
  json(res, {
    token,
    pack: group.length > 1,
    action: missing?.replaceExisting ? "replace-file" : missing ? "download" : "replace",
    releases: releases.map((r, index) => ({
      index,
      title: r.title,
      size: r.size,
      seeders: r.seeders ?? null,
      quality: r.quality?.quality?.name ?? "Unknown",
      languages: r.languages?.map((l) => l.name) ?? [],
      problems: releaseProblems(r, group, !missing, missing?.replaceExisting),
    })),
  });
}
export async function handleReleaseSwitch({ auth, req, res }: RouteContext): Promise<void> {
  authorize(auth.userId);
  const body = await parseJsonBody(req);
  const token = typeof body["token"] === "string" ? body["token"] : "";
  const selection = selections.get(token);
  if (selection?.user !== auth.userId || selection.expires < Date.now())
    throw new ClientError(409, "Search expired. Find alternatives again.");
  const index = body["index"];
  const release =
    typeof index === "number" && Number.isSafeInteger(index)
      ? selection.releases[index]
      : undefined;
  if (
    !release ||
    body["confirmed"] !== true ||
    releaseProblems(
      release,
      selection.group,
      !selection.missing,
      selection.missing?.replaceExisting,
    ).length
  )
    throw new ClientError(400, "Choose an eligible release and confirm replacement");
  const { instance, group } = selection;
  const key = scopeKey(instance, group);
  if (busy.has(key)) throw new ClientError(409, "Another replacement is in progress");
  busy.add(key);
  try {
    const current = selection.missing
      ? await missingGroup(instance, selection.missing)
      : groupFor(await queue(instance), firstItem(group).id);
    if (
      current.length !== group.length ||
      current.some(
        (i) =>
          !group.some(
            (old) =>
              old.id === i.id &&
              old.downloadId === i.downloadId &&
              old.episodeId === i.episodeId &&
              old.movieId === i.movieId &&
              old.seriesId === i.seriesId &&
              old.episodeFileId === i.episodeFileId,
          ),
      )
    )
      throw new ClientError(409, "Download changed. Search again.");
    authorize(auth.userId);
    reserve(key);
    selections.delete(token); // Never replay a possibly successful grab, including after a timeout.
    audit(
      auth.userId,
      instance.name,
      firstItem(group).id,
      selection.missing?.replaceExisting
        ? "file_replacement_attempted"
        : selection.missing
          ? "download_attempted"
          : "switch_attempted",
      selection.missing?.episodeId,
    );
    try {
      await arr(instance, "release", "POST", {
        guid: release.guid,
        indexerId: release.indexerId,
        ...(instance.type === "radarr"
          ? { movieId: firstItem(group).movieId }
          : { seriesId: firstItem(group).seriesId, episodeIds: group.map((i) => i.episodeId) }),
      });
    } catch {
      audit(
        auth.userId,
        instance.name,
        firstItem(group).id,
        "grab_unconfirmed",
        selection.missing?.episodeId,
      );
      throw new ClientError(
        502,
        selection.missing
          ? "Could not confirm the new download. Refresh episodes before trying again."
          : "Could not confirm the new download. The old transfer was not removed. Refresh status before trying again.",
      );
    }
    if (selection.missing) {
      audit(
        auth.userId,
        instance.name,
        0,
        selection.missing.replaceExisting ? "file_replacement_accepted" : "download_accepted",
        selection.missing.episodeId,
      );
      json(res, {
        success: true,
        ...(selection.missing.replaceExisting
          ? {
              message:
                "Replacement download accepted. The current file stays while it downloads; Sonarr will handle replacement during import.",
            }
          : {}),
      });
      return;
    }
    // Grab succeeded. Only remove the original identity, never a refreshed/new queue ID.
    let warning: string | undefined;
    try {
      let remaining = await queue(instance);
      const replacementVisible = () =>
        remaining.some(
          (i) =>
            i.downloadId &&
            i.downloadId !== firstItem(group).downloadId &&
            i.movieId === firstItem(group).movieId &&
            i.seriesId === firstItem(group).seriesId &&
            (release.infoHash
              ? i.downloadId.toLowerCase() === release.infoHash.toLowerCase()
              : i.title === release.title),
        );
      for (let attempt = 0; !replacementVisible() && attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        remaining = await queue(instance);
      }
      if (!replacementVisible()) throw new Error("Separate replacement transfer not yet visible");
      const original = remaining.find(
        (i) => i.id === firstItem(group).id && i.downloadId === firstItem(group).downloadId,
      );
      if (original) {
        if (!editable(original)) throw new Error("Original transfer finished while switching");
        await arr(
          instance,
          `queue/${original.id}?removeFromClient=true&blocklist=false&skipRedownload=true`,
          "DELETE",
        );
      }
    } catch {
      warning =
        "New release accepted, but the old transfer could not be safely removed. Ask the admin to check for duplicate downloads.";
    }
    audit(
      auth.userId,
      instance.name,
      firstItem(group).id,
      warning ? "cleanup_needed" : "switch_accepted",
    );
    json(res, { success: true, warning });
  } finally {
    busy.delete(key);
  }
}
