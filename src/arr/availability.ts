import { config } from "../config.js";
import * as seerr from "../seerr/client.js";
import { log } from "../logger.js";

export async function waitingForRelease(request: seerr.RequestDetails): Promise<boolean> {
  if (request.type !== "movie" || !request.media?.tmdbId) return false;
  const tmdbId = request.media.tmdbId;
  const url = request.is4k ? config.RADARR_4K_URL : config.RADARR_URL;
  const key = request.is4k ? config.RADARR_4K_API_KEY : config.RADARR_API_KEY;
  try {
    if (url && key) {
      const services = (await seerr.getRadarrServices()).filter(
        (service) => service.is4k === request.is4k,
      );
      const target = services[0];
      // Direct URLs map to one instance per quality tier. Ambiguous routing must fall back.
      if (
        services.length === 1 &&
        target &&
        (request.serverId == null || request.serverId === target.id)
      ) {
        const response = await fetch(`${url}/api/v3/movie?tmdbId=${tmdbId}`, {
          headers: { "X-Api-Key": key },
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        if (response.ok) {
          const movies = (await response.json()) as { tmdbId: number; isAvailable?: boolean }[];
          const movie = movies.find((item) => item.tmdbId === tmdbId);
          if (typeof movie?.isAvailable === "boolean") return !movie.isAvailable;
        }
      }
    }
  } catch (error) {
    log.debug({ err: error, tmdbId }, "Radarr availability lookup failed");
  }
  try {
    const movie = await seerr.getMovieDetails(tmdbId);
    const release = Date.parse(movie.releaseDate ?? "");
    return (
      ["planned", "in production", "post production"].includes(movie.status.toLowerCase()) ||
      (Number.isFinite(release) && release > Date.now())
    );
  } catch {
    return false;
  }
}
