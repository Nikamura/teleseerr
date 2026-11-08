import { test, after } from "node:test";
import assert from "node:assert/strict";
Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "dummy",
  SEERR_URL: "https://seerr.invalid",
  SEERR_API_KEY: "dummy",
  TELESEERR_ADMIN_USER_ID: "1",
  TELESEERR_PLEX_URL: "https://plex.invalid",
  TELESEERR_PLEX_TOKEN: "secret",
  LOG_LEVEL: "silent",
});
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});
test("playback exposes only the linked Plex account and exact mapped title", async () => {
  const { playbackStatus } = await import("../src/arr/playback.js");
  const session = (user: number, key: string) => ({
    User: { id: user },
    grandparentRatingKey: key,
    Player: { product: `viewer-${user}`, state: "playing" },
    TranscodeSession: { videoDecision: "transcode" },
    Media: [
      {
        Part: [{ Stream: [{ streamType: 2, selected: true, language: "English", codec: "aac" }] }],
      },
    ],
  });
  globalThis.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).includes("/user/")
          ? { plexId: 9 }
          : String(url).includes("/tv/")
            ? { mediaInfo: { ratingKey: "100" } }
            : {
                MediaContainer: {
                  Metadata: [session(9, "100"), session(10, "100"), session(9, "101")],
                },
              },
      ),
    );
  const result = await playbackStatus(9, "tv", 1421);
  assert.equal(result.available, true);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]!.device, "viewer-9");
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("viewer-10"));
});
test("missing Plex identity and service failure never expose shared sessions", async () => {
  const { playbackStatus } = await import("../src/arr/playback.js");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ id: 9 }));
  };
  assert.equal((await playbackStatus(9, "tv", 1421)).available, false);
  assert.equal(calls, 1);
  globalThis.fetch = async () => {
    throw new Error("secret service token");
  };
  const result = await playbackStatus(9, "tv", 1421);
  assert.equal(result.available, false);
  assert.ok(!JSON.stringify(result).includes("token"));
});
