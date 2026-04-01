// ── Seerr API Types ───────────────────────────────

export type SearchResult = {
  id: number;
  mediaType: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview: string;
  posterPath: string | null;
  voteAverage: number;
  popularity: number;
  mediaInfo: MediaInfo | null;
};

export type SearchResponse = {
  page: number;
  totalPages: number;
  totalResults: number;
  results: SearchResult[];
};

export type MediaInfo = {
  id: number;
  tmdbId: number;
  status: MediaStatus;
  seasons?: SeasonStatus[];
  requests?: RequestInfo[];
};

export enum MediaStatus {
  UNKNOWN = 1,
  PENDING = 2,
  PROCESSING = 3,
  PARTIALLY_AVAILABLE = 4,
  AVAILABLE = 5,
}

export type SeasonStatus = {
  seasonNumber: number;
  status: MediaStatus;
};

export type RequestInfo = {
  id: number;
  status: RequestStatus;
  seasons?: { seasonNumber: number }[];
};

export enum RequestStatus {
  PENDING = 1,
  APPROVED = 2,
  DECLINED = 3,
  FAILED = 4,
  AVAILABLE = 5,
}

export type RelatedVideo = {
  url: string;
  key: string;
  name: string;
  size: number;
  type: string; // "Trailer", "Teaser", "Featurette", etc.
  site: string; // "YouTube"
};

export type CastMember = {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
  order: number;
};

export type CrewMember = {
  id: number;
  name: string;
  job: string;
  department: string;
};

export type ContentRating = {
  iso_3166_1: string;
  rating: string;
};

export type WatchProviderDetails = {
  id: number;
  name: string;
  logoPath: string;
};

export type WatchProviders = {
  flatrate?: WatchProviderDetails[];
  buy?: WatchProviderDetails[];
  rent?: WatchProviderDetails[];
};

export type MovieDetails = SearchResult & {
  runtime: number | null;
  genres: Genre[];
  tagline: string;
  status: string;
  relatedVideos: RelatedVideo[];
  credits: { cast: CastMember[]; crew: CrewMember[] };
  externalIds: { imdbId?: string; tmdbId?: number };
  releases?: {
    results: { iso_3166_1: string; release_dates: { certification: string }[] }[];
  };
  watchProviders?: WatchProviders[];
  budget?: number;
  revenue?: number;
  collection?: { id: number; name: string; posterPath?: string; backdropPath?: string };
};

export type Network = {
  id: number;
  name: string;
  logoPath: string | null;
};

export type TvDetails = SearchResult & {
  numberOfSeasons: number;
  status: string;
  genres: Genre[];
  seasons: TvSeason[];
  relatedVideos: RelatedVideo[];
  credits: { cast: CastMember[]; crew: CrewMember[] };
  externalIds: { imdbId?: string; tvdbId?: number; tmdbId?: number };
  networks: Network[];
  episodeRunTime: number[];
  contentRatings?: { results: ContentRating[] };
  createdBy?: { id: number; name: string }[];
  keywords: Keyword[];
  watchProviders?: WatchProviders[];
};

export type PersonDetails = {
  id: number;
  name: string;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  profilePath: string | null;
  knownForDepartment: string;
  alsoKnownAs: string[];
  gender: number;
};

export type PersonCreditCast = {
  id: number;
  mediaType: "movie" | "tv";
  title?: string;
  name?: string;
  character: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath: string | null;
  voteAverage: number;
  popularity: number;
  mediaInfo?: MediaInfo | null;
};

export type PersonCombinedCredits = {
  cast: PersonCreditCast[];
  crew: { id: number; mediaType: string; title?: string; name?: string; job: string; posterPath: string | null }[];
};

export type MediaItem = {
  id: number;
  tmdbId: number;
  mediaType: "movie" | "tv";
  status: MediaStatus;
  mediaAddedAt?: string;
};

export type TvSeason = {
  id: number;
  seasonNumber: number;
  episodeCount: number;
  name: string;
  airDate: string | null;
};

export type Genre = { id: number; name: string };

export type Keyword = { id: number; name: string };

export type SeerrUser = {
  id: number;
  email: string;
  username: string;
  plexUsername?: string;
  jellyfinUsername?: string;
  avatar: string;
  permissions: number;
  requestCount: number;
};

export type UserQuota = {
  movie: { limit: number; days: number; remaining: number; restricted: boolean };
  tv: { limit: number; days: number; remaining: number; restricted: boolean };
};

export type SeerrRequest = {
  id: number;
  status: RequestStatus;
  media: {
    tmdbId: number;
    status: MediaStatus;
    mediaType?: string;
  };
  createdAt: string;
  requestedBy: { id: number; username: string };
  is4k: boolean;
};

export type RequestListResponse = {
  pageInfo: { page: number; pages: number; results: number };
  results: SeerrRequest[];
};

// ── Bot Internal Types ────────────────────────────

export type AccountLink = {
  telegramUserId: number;
  seerrUserId: number;
  seerrUsername: string;
  linkedAt: number;
};

export type PendingUser = {
  telegramUserId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  requestedAt: number;
};

export type SeerrUserListResponse = {
  pageInfo: { page: number; pages: number; results: number };
  results: SeerrUser[];
};

export type CreateRequestResult = {
  success: boolean;
  requestId?: number;
  status?: RequestStatus;
  error?: "DUPLICATE" | "QUOTA" | "BLACKLISTED" | "NO_PERMISSION" | "NO_SEASONS" | "UNKNOWN";
};
