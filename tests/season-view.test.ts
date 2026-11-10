import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync("web/downloads.js", "utf8")
  .split("/** @param {string} type")[0]!
  .replace(/^import .*\n/gm, "");
const show = {
  seasons: [1, 2, 3, 4].map((seasonNumber) => ({ seasonNumber, episodeCount: 24 })),
  mediaInfo: {
    requests: [
      { status: 1, seasons: [{ seasonNumber: 2 }] },
      { status: 2, seasons: [{ seasonNumber: 3 }] },
      { status: 2, is4k: true, seasons: [{ seasonNumber: 1 }] },
    ],
  },
};
const episode = {
  id: 5,
  season: 1,
  episode: 1,
  state: "missing",
  monitored: false,
  title: "Episode",
};
function render(data: any, options: any = {}) {
  return runInNewContext(source + "\nrenderEpisodes(data, 1421, options)", {
    data,
    options: {
      show,
      seasonState: (_s: any, season: any) =>
        season.seasonNumber === 1 ? "requestable" : "approved",
      ...options,
    },
    escHtml: (s: unknown) => String(s),
  });
}
test("one season list separates requests from availability and contains both action types", () => {
  const html = render({
    canManage: true,
    libraries: [{ instance: "sonarr", inLibrary: true, episodes: [episode], searches: [] }],
  });
  assert.equal((html.match(/<details /g) ?? []).length, 4);
  assert.ok(html.includes("No active season request"));
  assert.ok(html.includes("Awaiting approval"));
  assert.ok(html.includes("Requested · approved"));
  assert.ok(html.includes("1 missing"));
  assert.ok(html.includes('data-state="requestable" data-season="1"'));
  assert.ok(html.includes('data-recover-episode="5"'));
  assert.ok(html.includes("Not monitored for downloads"));
  assert.equal(html.includes("Pick yer seasons"), false);
});
test("unconfigured or not-yet-added library still allows season requests without inventing missing episodes", () => {
  const html = render({ configured: false, canManage: false, libraries: [] });
  assert.equal((html.match(/<details /g) ?? []).length, 4);
  assert.ok(html.includes('data-state="requestable" data-season="1"'));
  assert.ok(html.includes("24 episodes"));
  assert.equal(html.includes("24 missing"), false);
  assert.equal(html.includes("data-recover-episode"), false);
});
test("episode monitoring never pretends there is a Seerr request, and actions remain permission-gated", () => {
  const html = render({
    canManage: false,
    libraries: [
      {
        instance: "sonarr",
        inLibrary: true,
        episodes: [{ ...episode, monitored: true }],
        searches: [],
      },
    ],
  });
  assert.ok(html.includes("Monitored for downloads"));
  assert.equal(html.includes("data-recover-episode"), false);
  assert.equal(html.includes("data-recover-season="), false);
});
test("4K requests are labelled only in the corresponding library", () => {
  const metadata = {
    seasons: [{ seasonNumber: 1 }],
    mediaInfo: { requests: [{ status: 2, is4k: true, seasons: [{ seasonNumber: 1 }] }] },
  };
  const standard = render(
    { libraries: [{ instance: "sonarr", inLibrary: true, episodes: [episode] }] },
    { show: metadata },
  );
  const fourk = render(
    { libraries: [{ instance: "sonarr4k", inLibrary: true, episodes: [episode] }] },
    { show: metadata },
  );
  assert.ok(standard.includes("No active season request"));
  assert.ok(fourk.includes("Requested · approved"));
  assert.equal(fourk.includes('data-state="requestable"'), false);
});

test("season selection survives rerender and cannot include pending/non-selectable seasons", () => {
  const detail = readFileSync("web/detail.js", "utf8");
  const handler = detail
    .slice(
      detail.indexOf("export function attachSeasonHandlers"),
      detail.indexOf("/** @returns {void} */\nexport function updateClearBtn"),
    )
    .replace("export function", "function");
  const selected = new Set<number>([1, 2]);
  const button = {
    dataset: { season: "1" },
    classList: { toggle() {} },
    setAttribute() {},
    textContent: "",
    onclick: null as null | (() => void),
  };
  const controls: Record<string, any> = {
    "#select-all": {},
    "#select-new": null,
    "#clear-selection": {},
  };
  const view = { querySelectorAll: () => [button], querySelector: (s: string) => controls[s] };
  let updates = 0;
  const context = {
    show,
    view,
    getSelectedSeasons: () => selected,
    haptic() {},
    updateClearBtn() {},
    updateTvRequestBar() {
      updates++;
    },
  };
  runInNewContext(handler + "\nattachSeasonHandlers(show,view)", context);
  assert.deepEqual([...selected], [1]);
  assert.equal(button.textContent, "✓ Selected season 1");
  runInNewContext(handler + "\nattachSeasonHandlers(show,view)", context);
  assert.deepEqual([...selected], [1]);
  button.onclick!();
  assert.equal(selected.size, 0);
  controls["#select-all"].onclick();
  assert.deepEqual([...selected], [1]);
  controls["#clear-selection"].onclick();
  assert.equal(selected.size, 0);
  assert.ok(updates >= 4);
});
