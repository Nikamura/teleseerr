import { config } from "../config.js";
import { log } from "../logger.js";
import type {
  CreateRequestResult,
  MediaItem,
  MovieDetails,
  PersonCombinedCredits,
  PersonDetails,
  RequestListResponse,
  SearchResponse,
  SeerrUser,
  SeerrUserListResponse,
  TvDetails,
  UserQuota,
} from "../types.js";

const BASE = `${config.SEERR_URL}/api/v1`;

async function seerrFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": config.SEERR_API_KEY,
    ...(init?.headers as Record<string, string>),
  };

  const start = Date.now();
  const res = await fetch(url, { ...init, headers });
  const ms = Date.now() - start;

  log.debug({ endpoint: path, status: res.status, ms }, "seerr request");

  return res;
}

export async function search(query: string, page = 1): Promise<SearchResponse> {
  const res = await seerrFetch(`/search?query=${encodeURIComponent(query)}&page=${page}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function getMovieDetails(tmdbId: number): Promise<MovieDetails> {
  const res = await seerrFetch(`/movie/${tmdbId}`);
  if (!res.ok) throw new Error(`Movie details failed: ${res.status}`);
  return res.json() as Promise<MovieDetails>;
}

export async function getTvDetails(tmdbId: number): Promise<TvDetails> {
  const res = await seerrFetch(`/tv/${tmdbId}`);
  if (!res.ok) throw new Error(`TV details failed: ${res.status}`);
  return res.json() as Promise<TvDetails>;
}

export async function createRequest(payload: {
  mediaType: "movie" | "tv";
  mediaId: number;
  seasons?: number[] | undefined;
  is4k?: boolean | undefined;
  userId?: number | undefined;
  serverId?: number | undefined;
}): Promise<CreateRequestResult> {
  const res = await seerrFetch("/request", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (res.status === 201) {
    const data = (await res.json()) as { id?: number; status?: number };
    return { success: true, requestId: data.id, status: data.status };
  }

  if (res.status === 202) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    const msg = data.message ?? "";
    if (msg.includes("No seasons available")) return { success: false, error: "NO_SEASONS" };
    return { success: false, error: "UNKNOWN" };
  }
  if (res.status === 409) return { success: false, error: "DUPLICATE" };
  if (res.status === 403) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    const msg = data.message ?? "";
    if (msg.includes("quota")) return { success: false, error: "QUOTA" };
    if (msg.includes("blacklist")) return { success: false, error: "BLACKLISTED" };
    return { success: false, error: "NO_PERMISSION" };
  }

  const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  log.warn({ status: res.status, body: errBody }, "Unexpected Seerr request response");
  return { success: false, error: "UNKNOWN" };
}

export async function getRequests(opts: {
  take?: number;
  skip?: number;
  filter?: string;
  sort?: string;
  requestedBy?: number;
}): Promise<RequestListResponse> {
  const params = new URLSearchParams();
  if (opts.take) params.set("take", String(opts.take));
  if (opts.skip) params.set("skip", String(opts.skip));
  if (opts.filter) params.set("filter", opts.filter);
  if (opts.sort) params.set("sort", opts.sort);
  if (opts.requestedBy) params.set("requestedBy", String(opts.requestedBy));
  params.set("sortDirection", "desc");

  const res = await seerrFetch(`/request?${params}`);
  if (!res.ok) throw new Error(`Get requests failed: ${res.status}`);
  return res.json() as Promise<RequestListResponse>;
}

export async function getUserQuota(seerrUserId: number): Promise<UserQuota> {
  const res = await seerrFetch(`/user/${seerrUserId}/quota`);
  if (!res.ok) throw new Error(`Get quota failed: ${res.status}`);
  return res.json() as Promise<UserQuota>;
}

export async function getTrending(page = 1): Promise<SearchResponse> {
  const res = await seerrFetch(`/discover/trending?page=${page}`);
  if (!res.ok) throw new Error(`Trending failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function getUsers(opts?: {
  take?: number;
  skip?: number;
}): Promise<SeerrUserListResponse> {
  const params = new URLSearchParams();
  if (opts?.take) params.set("take", String(opts.take));
  if (opts?.skip) params.set("skip", String(opts.skip));
  const res = await seerrFetch(`/user?${params}`);
  if (!res.ok) throw new Error(`Get users failed: ${res.status}`);
  return res.json() as Promise<SeerrUserListResponse>;
}

export async function getUser(seerrUserId: number): Promise<SeerrUser | null> {
  const res = await seerrFetch(`/user/${seerrUserId}`);
  if (!res.ok) return null;
  return res.json() as Promise<SeerrUser>;
}

export type ServiceSettings = {
  id: number;
  name: string;
  is4k: boolean;
  isDefault: boolean;
};

export async function getRadarrServices(): Promise<ServiceSettings[]> {
  const res = await seerrFetch("/service/radarr");
  if (!res.ok) return [];
  return res.json() as Promise<ServiceSettings[]>;
}

export async function getSonarrServices(): Promise<ServiceSettings[]> {
  const res = await seerrFetch("/service/sonarr");
  if (!res.ok) return [];
  return res.json() as Promise<ServiceSettings[]>;
}

export async function getGenres(type: "movie" | "tv"): Promise<{ id: number; name: string }[]> {
  const res = await seerrFetch(`/discover/genreslider/${type}`);
  if (!res.ok) return [];
  return res.json() as Promise<{ id: number; name: string }[]>;
}

export async function discover(
  type: "movie" | "tv",
  opts: {
    genre?: number | undefined;
    page?: number | undefined;
    sortBy?: string | undefined;
    primaryReleaseDateGte?: string | undefined;
    primaryReleaseDateLte?: string | undefined;
    firstAirDateGte?: string | undefined;
    firstAirDateLte?: string | undefined;
    voteAverageGte?: string | undefined;
    voteAverageLte?: string | undefined;
    withRuntimeGte?: string | undefined;
    withRuntimeLte?: string | undefined;
    keywords?: string | undefined;
  } = {},
): Promise<SearchResponse> {
  const params = new URLSearchParams();
  params.set("page", String(opts.page ?? 1));
  if (opts.genre) params.set("genre", String(opts.genre));
  if (opts.sortBy) params.set("sortBy", opts.sortBy);
  if (opts.primaryReleaseDateGte) params.set("primaryReleaseDateGte", opts.primaryReleaseDateGte);
  if (opts.primaryReleaseDateLte) params.set("primaryReleaseDateLte", opts.primaryReleaseDateLte);
  if (opts.firstAirDateGte) params.set("firstAirDateGte", opts.firstAirDateGte);
  if (opts.firstAirDateLte) params.set("firstAirDateLte", opts.firstAirDateLte);
  if (opts.voteAverageGte) params.set("voteAverageGte", opts.voteAverageGte);
  if (opts.voteAverageLte) params.set("voteAverageLte", opts.voteAverageLte);
  if (opts.withRuntimeGte) params.set("withRuntimeGte", opts.withRuntimeGte);
  if (opts.withRuntimeLte) params.set("withRuntimeLte", opts.withRuntimeLte);
  if (opts.keywords) params.set("keywords", opts.keywords);
  const endpoint = type === "movie" ? "movies" : "tv";
  const res = await seerrFetch(`/discover/${endpoint}?${params}`);
  if (!res.ok) throw new Error(`Discover failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function getMovieRecommendations(tmdbId: number, page = 1): Promise<SearchResponse> {
  const res = await seerrFetch(`/movie/${tmdbId}/recommendations?page=${page}`);
  if (!res.ok) throw new Error(`Recommendations failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function getMovieSimilar(tmdbId: number, page = 1): Promise<SearchResponse> {
  const res = await seerrFetch(`/movie/${tmdbId}/similar?page=${page}`);
  if (!res.ok) throw new Error(`Similar failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function getTvRecommendations(tmdbId: number, page = 1): Promise<SearchResponse> {
  const res = await seerrFetch(`/tv/${tmdbId}/recommendations?page=${page}`);
  if (!res.ok) throw new Error(`Recommendations failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function getTvSimilar(tmdbId: number, page = 1): Promise<SearchResponse> {
  const res = await seerrFetch(`/tv/${tmdbId}/similar?page=${page}`);
  if (!res.ok) throw new Error(`Similar failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function getPersonDetails(personId: number): Promise<PersonDetails> {
  const res = await seerrFetch(`/person/${personId}`);
  if (!res.ok) throw new Error(`Person details failed: ${res.status}`);
  return res.json() as Promise<PersonDetails>;
}

export async function getPersonCombinedCredits(personId: number): Promise<PersonCombinedCredits> {
  const res = await seerrFetch(`/person/${personId}/combined_credits`);
  if (!res.ok) throw new Error(`Person credits failed: ${res.status}`);
  return res.json() as Promise<PersonCombinedCredits>;
}

export async function discoverUpcoming(type: "movie" | "tv", page = 1): Promise<SearchResponse> {
  const endpoint = type === "movie" ? "movies/upcoming" : "tv/upcoming";
  const res = await seerrFetch(`/discover/${endpoint}?page=${page}`);
  if (!res.ok) throw new Error(`Upcoming failed: ${res.status}`);
  return res.json() as Promise<SearchResponse>;
}

export async function getRecentlyAdded(
  take = 20,
  skip = 0,
): Promise<{ results: MediaItem[]; pageInfo: { pages: number; page: number; results: number } }> {
  const params = new URLSearchParams({
    filter: "allavailable",
    sort: "mediaAdded",
    take: String(take),
    skip: String(skip),
  });
  const res = await seerrFetch(`/media?${params}`);
  if (!res.ok) throw new Error(`Recently added failed: ${res.status}`);
  const data = (await res.json()) as {
    results?: MediaItem[];
    pageInfo?: {
      pages?: number;
      totalPages?: number;
      page?: number;
      currentPage?: number;
      results?: number;
      totalResults?: number;
    };
  };
  // Normalize pageInfo field names (Overseerr uses different names)
  const pi = data.pageInfo ?? {};
  return {
    results: data.results ?? [],
    pageInfo: {
      pages: pi.pages ?? pi.totalPages ?? 1,
      page: pi.page ?? pi.currentPage ?? 1,
      results: pi.results ?? pi.totalResults ?? 0,
    },
  };
}
