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

type QueueItem = {
  id: number;
  downloadId: string;
  movieId?: number;
  seriesId?: number;
  episodeId?: number;
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
  quality?: { quality?: { name?: string } };
  languages?: { name: string }[];
  fullSeason?: boolean;
  seasonNumber?: number;
  episodeNumbers?: number[];
  infoHash?: string;
};
type Selection = {
  user: number;
  instance: ArrInstance;
  group: QueueItem[];
  releases: Release[];
  expires: number;
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
      "A switch was recently attempted. Refresh and wait two minutes before trying again.",
    );
  mkdirSync(config.DATA_DIR, { recursive: true });
  const next = Object.fromEntries(
    Object.entries(times).filter(([, time]) => Date.now() - time < 120_000),
  );
  next[key] = Date.now();
  writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(next), { mode: 0o600 });
  renameSync(`${ledgerPath}.tmp`, ledgerPath);
}
function audit(user: number, instance: string, queueId: number, event: string): void {
  mkdirSync(config.DATA_DIR, { recursive: true });
  appendFileSync(
    join(config.DATA_DIR, "download-activity.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), user, instance, queueId, event }) + "\n",
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
async function arr<T>(
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
async function queue(instance: ArrInstance): Promise<QueueItem[]> {
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
function instanceByName(name: unknown): ArrInstance {
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
export function releaseProblems(release: Release, group: QueueItem[]): string[] {
  const reasons = [...(release.rejections ?? [])].filter(
    (reason) =>
      !/^(?:Quality for release in queue already meets cutoff:|Release in queue (?:already meets cutoff:|is of equal or higher (?:preference|revision):|meets (?:quality|Custom Format) cutoff:|has (?:an equal or higher Custom Format score:|Custom Format score within Custom Format score increment:)|and Quality Profile '.+' does not allow upgrades$))/.test(
        reason,
      ),
  );
  if (release.protocol !== "torrent") reasons.push("Only torrent replacements are supported");
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
export async function handleDownloads({ auth, params, res }: RouteContext): Promise<void> {
  authorize(auth.userId);
  const id = Number(params["id"]),
    type = params["type"];
  if (!Number.isSafeInteger(id) || id <= 0 || !["movie", "tv"].includes(type ?? ""))
    throw new ClientError(400, "Invalid title");
  const tv = type === "tv" ? await seerr.getTvDetails(id) : undefined;
  const instances = getInstances()[type === "movie" ? "radarr" : "sonarr"];
  const results = await Promise.all(
    instances.map(async (instance) => {
      const items = await queue(instance);
      const matched = items.filter((i) =>
        type === "movie"
          ? i.movie?.tmdbId === id
          : i.series?.tmdbId === id ||
            (!!tv?.externalIds.tvdbId && i.series?.tvdbId === tv.externalIds.tvdbId),
      );
      const seen = new Set<string>();
      return matched
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
          canReplace: editable(i),
        }));
    }),
  );
  json(res, { configured: instances.length > 0, items: results.flat(), updatedAt: Date.now() });
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
  const group = groupFor(await queue(instance), body["queueId"]);
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
  const releases = (await arr<Release[]>(instance, `release?${query}`)).slice(0, 300);
  authorize(auth.userId);
  const token = randomUUID();
  selections.set(token, {
    user: auth.userId,
    instance,
    group,
    releases,
    expires: Date.now() + 120_000,
  });
  json(res, {
    token,
    pack: group.length > 1,
    releases: releases.map((r, index) => ({
      index,
      title: r.title,
      size: r.size,
      seeders: r.seeders ?? null,
      quality: r.quality?.quality?.name ?? "Unknown",
      languages: r.languages?.map((l) => l.name) ?? [],
      problems: releaseProblems(r, group),
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
  if (!release || body["confirmed"] !== true || releaseProblems(release, selection.group).length)
    throw new ClientError(400, "Choose an eligible release and confirm replacement");
  const { instance, group } = selection;
  const key = scopeKey(instance, group);
  if (busy.has(key)) throw new ClientError(409, "Another replacement is in progress");
  busy.add(key);
  try {
    const current = groupFor(await queue(instance), firstItem(group).id);
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
              old.seriesId === i.seriesId,
          ),
      )
    )
      throw new ClientError(409, "Download changed. Search again.");
    authorize(auth.userId);
    reserve(key);
    selections.delete(token); // Never replay a possibly successful grab, including after a timeout.
    audit(auth.userId, instance.name, firstItem(group).id, "switch_attempted");
    try {
      await arr(instance, "release", "POST", {
        guid: release.guid,
        indexerId: release.indexerId,
        ...(instance.type === "radarr"
          ? { movieId: firstItem(group).movieId }
          : { seriesId: firstItem(group).seriesId, episodeIds: group.map((i) => i.episodeId) }),
      });
    } catch {
      audit(auth.userId, instance.name, firstItem(group).id, "grab_unconfirmed");
      throw new ClientError(
        502,
        "Could not confirm the new download. The old transfer was not removed. Refresh status before trying again.",
      );
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
