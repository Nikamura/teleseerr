import { config } from "../config.js";
import * as seerr from "../seerr/client.js";

type Session = {
  ratingKey?: string;
  grandparentRatingKey?: string;
  User?: { id?: string | number };
  Player?: { product?: string; platform?: string; state?: string; local?: boolean };
  TranscodeSession?: { videoDecision?: string; audioDecision?: string; subtitleDecision?: string };
  Media?: {
    Part?: {
      Stream?: { streamType: number; selected?: boolean; language?: string; codec?: string }[];
    }[];
  }[];
};
export async function playbackStatus(userId: number, type: string, tmdbId: number) {
  const unavailable = {
    available: false,
    sessions: [] as {
      device: string;
      state: string;
      video: string;
      audio: string;
      subtitles: string;
      selectedTracks: { kind: string; language: string; codec: string }[];
    }[],
    message: "Live playback diagnostics are unavailable. Report the device and player you use.",
  };
  if (!config.PLEX_URL || !config.PLEX_TOKEN) return unavailable;
  try {
    const user = await seerr.getUser(userId);
    if (!user?.plexId)
      return {
        ...unavailable,
        message: "Your Seerr account has no verified Plex identity. Session details are hidden.",
      };
    const details =
      type === "tv" ? await seerr.getTvDetails(tmdbId) : await seerr.getMovieDetails(tmdbId);
    const info = details.mediaInfo as { ratingKey?: string; ratingKey4k?: string } | undefined;
    const keys = [info?.ratingKey, info?.ratingKey4k].filter(Boolean).map(String);
    if (!keys.length)
      return { ...unavailable, message: "This title has no verified Plex library mapping." };
    const response = await fetch(`${config.PLEX_URL}/status/sessions`, {
      headers: { "X-Plex-Token": config.PLEX_TOKEN, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return unavailable;
    const data = (await response.json()) as { MediaContainer?: { Metadata?: Session[] } };
    const sessions = (data.MediaContainer?.Metadata ?? []).filter(
      (s) =>
        String(s.User?.id) === String(user.plexId) &&
        keys.includes(String(type === "tv" ? s.grandparentRatingKey : s.ratingKey)),
    );
    return {
      available: true,
      sessions: sessions.map((s) => ({
        device: s.Player?.product ?? s.Player?.platform ?? "Unknown player",
        state: s.Player?.state ?? "Unknown",
        video: s.TranscodeSession?.videoDecision ?? "Direct playback",
        audio: s.TranscodeSession?.audioDecision ?? "Direct playback",
        subtitles: s.TranscodeSession?.subtitleDecision ?? "Not transcoded",
        selectedTracks: (s.Media ?? [])
          .flatMap((m) => m.Part ?? [])
          .flatMap((p) => p.Stream ?? [])
          .filter((t) => t.selected)
          .map((t) => ({
            kind: t.streamType === 2 ? "Audio" : t.streamType === 3 ? "Subtitles" : "Video",
            language: t.language ?? "Unknown",
            codec: t.codec ?? "Unknown",
          })),
      })),
      message: sessions.length
        ? "Only your active Plex playback for this title is shown."
        : "No active Plex playback for this title on your linked account. Start playback, then check again.",
    };
  } catch {
    return unavailable;
  }
}
