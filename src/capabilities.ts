import { config } from "./config.js";
import { log } from "./logger.js";
import * as seerr from "./seerr/client.js";

// Fetched once on startup — what the Seerr instance supports
export const capabilities = {
  has4kMovie: false,
  has4kTv: false,
  animeSonarrId: null as number | null,
};

export async function loadCapabilities(): Promise<void> {
  try {
    const [radarr, sonarr] = await Promise.all([
      seerr.getRadarrServices(),
      seerr.getSonarrServices(),
    ]);

    capabilities.has4kMovie = radarr.some((s) => s.is4k);
    capabilities.has4kTv = sonarr.some((s) => s.is4k);

    capabilities.animeSonarrId = config.ANIME_SONARR_ID ? Number(config.ANIME_SONARR_ID) : null;

    log.info(
      {
        has4kMovie: capabilities.has4kMovie,
        has4kTv: capabilities.has4kTv,
        animeSonarrId: capabilities.animeSonarrId,
      },
      "Seerr capabilities loaded",
    );
  } catch (e) {
    log.warn(e, "Failed to load Seerr capabilities — 4K buttons disabled");
  }
}
