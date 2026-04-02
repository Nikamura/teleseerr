import type { Bot } from "grammy";
import { json, error, parseJsonBody, numParam, pageParam, type RouteContext } from "../http.js";
import { canRequest, canSearch, accountStore } from "../stores.js";
import * as seerr from "../seerr/client.js";
import { getMovieProgress, getTvProgress } from "../arr/client.js";
import { capabilities } from "../capabilities.js";
import { log } from "../logger.js";
import { sendAutoApproveNotification } from "../notifications.js";
import { RequestStatus } from "../types.js";

// ── Bot Instance ─────────────────────────────────

let botInstance: Bot | null = null;

export function setMediaBotInstance(bot: Bot): void {
  botInstance = bot;
}

// ── Media Routes ──────────────────────────────────

export async function handleTrending({ res, url }: RouteContext): Promise<void> {
  json(res, await seerr.getTrending(pageParam(url)));
}

export async function handleSearch({ res, url, auth }: RouteContext): Promise<void> {
  if (!canSearch(auth.userId)) return error(res, "Too many requests", 429);
  const q = url.searchParams.get("q") ?? "";
  if (q.length < 2) return json(res, { results: [], totalPages: 0, totalResults: 0 });
  json(res, await seerr.search(q, pageParam(url)));
}

export function handleCapabilities({ res }: RouteContext): void {
  json(res, {
    has4kMovie: capabilities.has4kMovie,
    has4kTv: capabilities.has4kTv,
    hasProgressRadarr: capabilities.hasProgressRadarr,
    hasProgressSonarr: capabilities.hasProgressSonarr,
  });
}

export async function handleMovieRecommendations({
  res,
  url,
  params,
}: RouteContext): Promise<void> {
  json(res, await seerr.getMovieRecommendations(numParam(params, "id"), pageParam(url)));
}

export async function handleMovieSimilar({ res, url, params }: RouteContext): Promise<void> {
  json(res, await seerr.getMovieSimilar(numParam(params, "id"), pageParam(url)));
}

export async function handleTvRecommendations({ res, url, params }: RouteContext): Promise<void> {
  json(res, await seerr.getTvRecommendations(numParam(params, "id"), pageParam(url)));
}

export async function handleTvSimilar({ res, url, params }: RouteContext): Promise<void> {
  json(res, await seerr.getTvSimilar(numParam(params, "id"), pageParam(url)));
}

export async function handlePerson({ res, params }: RouteContext): Promise<void> {
  const id = numParam(params, "id");
  const [details, credits] = await Promise.all([
    seerr.getPersonDetails(id),
    seerr.getPersonCombinedCredits(id),
  ]);
  json(res, { ...details, combinedCredits: credits });
}

export async function handleRecentlyAdded({ res, url }: RouteContext): Promise<void> {
  const page = pageParam(url);
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

export async function handleMovieDetails({ res, params }: RouteContext): Promise<void> {
  json(res, await seerr.getMovieDetails(numParam(params, "id")));
}

export async function handleTvDetails({ res, params }: RouteContext): Promise<void> {
  json(res, await seerr.getTvDetails(numParam(params, "id")));
}

export async function handleMovieGenres({ res }: RouteContext): Promise<void> {
  json(res, await seerr.getGenres("movie"));
}

export async function handleTvGenres({ res }: RouteContext): Promise<void> {
  json(res, await seerr.getGenres("tv"));
}

export async function handleDiscoverUpcoming({ res, url, params }: RouteContext): Promise<void> {
  json(res, await seerr.discoverUpcoming(params["type"] as "movie" | "tv", pageParam(url)));
}

export async function handleDiscover({ res, url, params }: RouteContext): Promise<void> {
  const type = params["type"] as "movie" | "tv";
  const genre = url.searchParams.get("genre");
  json(
    res,
    await seerr.discover(type, {
      genre: genre ? Number(genre) : undefined,
      page: pageParam(url),
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

export async function handleRequest({ req, res, auth }: RouteContext): Promise<void> {
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

  if (result.success && result.status === RequestStatus.APPROVED && botInstance) {
    sendAutoApproveNotification(botInstance, auth.userId, mediaType, mediaId);
  }
}

export async function handleRequests({ res, url, auth }: RouteContext): Promise<void> {
  const account = accountStore.get(auth.userId);
  if (!account) return error(res, "Account not linked", 403);

  const page = pageParam(url);
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

export async function handleMovieProgress({ res, params }: RouteContext): Promise<void> {
  if (!capabilities.hasProgressRadarr) {
    return json(res, { available: false, items: [], isSeasonPack: false });
  }
  json(res, await getMovieProgress(numParam(params, "id")));
}

export async function handleTvProgress({ res, url, params }: RouteContext): Promise<void> {
  if (!capabilities.hasProgressSonarr) {
    return json(res, { available: false, items: [], isSeasonPack: false });
  }
  const tvdbId = url.searchParams.get("tvdbId");
  json(res, await getTvProgress(numParam(params, "id"), tvdbId ? Number(tvdbId) : undefined));
}

export async function handleQuota({ res, auth }: RouteContext): Promise<void> {
  const account = accountStore.get(auth.userId);
  if (!account) return error(res, "Account not linked", 403);
  json(res, await seerr.getUserQuota(account.seerrUserId));
}
