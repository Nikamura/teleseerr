import { getInstances } from "./arr/client.js";
import { arr, findSeries, type Episode } from "./routes/downloads.js";
import { reports, markReplacement } from "./support-store.js";
import { accountStore } from "./stores.js";
import { config } from "./config.js";
let running = false;
let offset = 0;
export async function checkReports(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const active = reports(config.ADMIN_USER_ID, true).filter(
      (r) => r.status === "open" || r.status === "investigating",
    );
    const batch = active.slice(offset, offset + 10);
    offset = offset + 10 >= active.length ? 0 : offset + 10;
    for (const report of batch) {
      if (!accountStore.get(report.owner) && report.owner !== config.ADMIN_USER_ID) continue;
      try {
        const instances = getInstances()[report.type === "tv" ? "sonarr" : "radarr"].filter(
          (i) => !report.instance || i.name === report.instance,
        );
        const fileIds: string[] = [];
        for (const instance of instances) {
          if (report.type === "movie") {
            const movie = (
              await arr<{ tmdbId: number; hasFile: boolean; movieFile?: { id: number } }[]>(
                instance,
                "movie",
              )
            ).find((m) => m.tmdbId === report.tmdbId);
            if (movie?.hasFile && movie.movieFile?.id)
              fileIds.push(`${instance.name}:${movie.movieFile.id}`);
          } else {
            const series = await findSeries(instance, report.tmdbId);
            if (!series) continue;
            const episodes = await arr<Episode[]>(instance, `episode?seriesId=${series.id}`);
            fileIds.push(
              ...episodes
                .filter(
                  (e) =>
                    (!report.episodeId || e.id === report.episodeId) &&
                    e.hasFile &&
                    e.episodeFileId,
                )
                .map((e) => `${instance.name}:${e.episodeFileId}`),
            );
          }
        }
        markReplacement(report.owner, report.type, report.tmdbId, report.episodeId, fileIds);
      } catch {
        /* A service failure never resolves a report. Recheck next cycle. */
      }
    }
  } finally {
    running = false;
  }
}
export function startSupportWatch(): void {
  const timer = setInterval(() => {
    void checkReports().catch(() => {
      /* Keep the periodic checker alive after a temporary store/service failure. */
    });
  }, 120000);
  timer.unref();
}
