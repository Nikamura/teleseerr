import { config } from "../config.js";
type Member = { id: number; tmdbId: number; addDate: string; mediaData?: { index?: number } };
type Collection = {
  id: number;
  type: string;
  isActive: boolean;
  arrAction: number;
  deleteAfterDays: number | null;
  media: Member[];
};
let cached: { at: number; collections: Collection[] } | undefined;
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${config.MAINTAINERR_URL}/api/collections${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error("Cleanup service unavailable");
  return r.json() as Promise<T>;
}
export async function cleanupStatus(
  type: string,
  id: number,
): Promise<{
  available: boolean;
  items: { season: number | null; eligibleAt: string | null; action: string }[];
}> {
  if (!config.MAINTAINERR_URL) return { available: false, items: [] };
  try {
    if (!cached || Date.now() - cached.at > 60000)
      cached = { at: Date.now(), collections: await get<Collection[]>("/overlay-data") };
    const collections = cached.collections.filter(
      (c) =>
        c.isActive &&
        c.arrAction !== 4 &&
        (type === "tv" ? ["show", "season"].includes(c.type) : c.type === "movie") &&
        c.media.some((m) => m.tmdbId === id),
    );
    const result = await Promise.all(
      collections.map(async (c) => {
        let members = c.media.filter((m) => m.tmdbId === id);
        if (c.type === "season") {
          const content: Member[] = [];
          for (let page = 0; page < 100; page++) {
            const d = await get<{ totalSize: number; items: Member[] }>(
              `/media/${c.id}/content/${page}?size=100`,
            );
            content.push(...d.items);
            if (content.length >= d.totalSize) break;
            if (!d.items.length || page === 99) throw new Error("Incomplete cleanup membership");
          }
          members = members.map((m) => ({
            ...m,
            mediaData: content.find((item) => item.id === m.id)?.mediaData ?? {},
          }));
        }
        const actions: Record<number, string> = {
          0: "Remove",
          1: "Unmonitor and remove all",
          2: "Unmonitor and remove",
          3: "Unmonitor",
          5: "Remove if empty",
          6: "Unmonitor if empty",
          7: "Change quality profile",
        };
        return members.map((m) => ({
          season: c.type === "season" ? (m.mediaData?.index ?? null) : null,
          eligibleAt:
            m.addDate && Number.isFinite(Date.parse(m.addDate))
              ? new Date(Date.parse(m.addDate) + (c.deleteAfterDays ?? 0) * 86400000).toISOString()
              : null,
          action: actions[c.arrAction] ?? "Library cleanup",
        }));
      }),
    );
    return { available: true, items: result.flat() };
  } catch {
    return { available: false, items: [] };
  }
}
