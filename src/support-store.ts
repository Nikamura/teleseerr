import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { ClientError } from "./http.js";

export const categories = [
  "download",
  "playback",
  "wrong-episode",
  "audio",
  "subtitles",
  "other",
] as const;
export type Report = {
  id: string;
  owner: number;
  type: "movie" | "tv";
  tmdbId: number;
  instance?: string;
  episodeId?: number;
  season?: number;
  category: string;
  title?: string;
  snapshot?: {
    checkedAt: string;
    services: { instance: string; reachable: boolean; monitored: boolean; problems: string[] }[];
  };
  device: string;
  notes: string;
  status: "open" | "investigating" | "replacement_available" | "resolved";
  createdAt: string;
  updatedAt: string;
  fileIds: string[];
  history: { at: string; message: string; actor: number }[];
};
type Data = {
  reports: Report[];
  preferences: Record<string, { audio: string; subtitles: string }>;
  cooldowns: Record<string, number>;
};
function read(): Data {
  const path = join(config.DATA_DIR, "support.json");
  if (!existsSync(path)) return { reports: [], preferences: {}, cooldowns: {} };
  const data = JSON.parse(readFileSync(path, "utf8")) as Partial<Data>;
  if (!Array.isArray(data.reports) || !data.preferences || !data.cooldowns)
    throw new Error("Invalid support store");
  return data as Data;
}
function write(data: Data): void {
  mkdirSync(config.DATA_DIR, { recursive: true });
  const path = join(config.DATA_DIR, "support.json");
  writeFileSync(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export function reports(owner: number, admin = false): Report[] {
  return read()
    .reports.filter((r) => admin || r.owner === owner)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function createReport(
  input: Omit<Report, "id" | "status" | "createdAt" | "updatedAt" | "history">,
): Report {
  const data = read();
  const duplicate = data.reports.find(
    (r) =>
      r.owner === input.owner &&
      r.type === input.type &&
      r.tmdbId === input.tmdbId &&
      r.episodeId === input.episodeId &&
      r.category === input.category &&
      r.status !== "resolved",
  );
  if (duplicate) return duplicate;
  if (data.reports.filter((r) => r.owner === input.owner && r.status !== "resolved").length >= 30)
    throw new ClientError(429, "Resolve an existing report before opening another.");
  const now = new Date().toISOString();
  const report: Report = {
    ...input,
    id: randomUUID(),
    status: "open",
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, actor: input.owner, message: "Report opened" }],
  };
  data.reports.push(report);
  write(data);
  return report;
}
export function updateReport(
  id: string,
  actor: number,
  admin: boolean,
  status: Report["status"],
  message: string,
): Report {
  const data = read();
  const report = data.reports.find((r) => r.id === id && (admin || r.owner === actor));
  if (!report) throw new ClientError(404, "Report not found");
  if (!admin && status !== "resolved" && status !== "open")
    throw new ClientError(403, "Only the admin can change investigation status");
  report.status = status;
  report.updatedAt = new Date().toISOString();
  report.history.push({
    at: report.updatedAt,
    actor,
    message:
      message ||
      (status === "resolved" ? "Playback confirmed working" : status.replaceAll("_", " ")),
  });
  report.history = report.history.slice(-50);
  write(data);
  return report;
}
export function markReplacement(
  owner: number,
  type: string,
  tmdbId: number,
  episodeId: number | undefined,
  fileIds: string[],
): void {
  const data = read();
  let changed = false;
  for (const r of data.reports) {
    if (
      r.owner !== owner ||
      r.type !== type ||
      r.tmdbId !== tmdbId ||
      r.episodeId !== episodeId ||
      !["open", "investigating"].includes(r.status) ||
      !fileIds.length ||
      !fileIds.some(
        (id) => (!r.instance || id.startsWith(`${r.instance}:`)) && !r.fileIds.includes(id),
      )
    )
      continue;
    r.status = "replacement_available";
    r.updatedAt = new Date().toISOString();
    r.history.push({
      at: r.updatedAt,
      actor: 0,
      message: "A different file is imported. Try playback and confirm whether it works.",
    });
    changed = true;
  }
  if (changed) write(data);
}
export function preferences(
  owner: number,
  value?: { audio: string; subtitles: string },
): { audio: string; subtitles: string } {
  const data = read();
  if (value) {
    data.preferences[String(owner)] = value;
    write(data);
  }
  return data.preferences[String(owner)] ?? { audio: "original", subtitles: "none" };
}
export function cooldown(key: string, seconds = 120): void {
  const data = read();
  const now = Date.now();
  if (now - (data.cooldowns[key] ?? 0) < seconds * 1000)
    throw new ClientError(
      429,
      "This action was recently attempted. Refresh and wait before trying again.",
    );
  data.cooldowns = Object.fromEntries(
    Object.entries(data.cooldowns).filter(([, v]) => now - v < 86400000),
  );
  data.cooldowns[key] = now;
  write(data);
}
