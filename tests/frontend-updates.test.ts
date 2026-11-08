import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("release notice waits through offline/same-release checks and never reloads a draft automatically", async () => {
  const source = readFileSync("web/updates.js", "utf8").replace(/export /g, "");
  let check: () => Promise<void>;
  let notice: any;
  let reloads = 0;
  let attempts = 0;
  const button: any = {};
  const document = {
    hidden: false,
    querySelector: (selector: string) => selector.includes("meta") ? { getAttribute: () => "first" } : { after: (value: any) => { notice = value; } },
    getElementById: () => notice,
    createElement: () => ({ setAttribute: () => {}, querySelector: () => button }),
    addEventListener: () => {},
  };
  runInNewContext(source + "\nwatchForUpdates()", {
    document, window: { addEventListener: () => {} }, location: { reload: () => reloads++ },
    setInterval: (callback: () => Promise<void>) => { check = callback; },
    fetch: async () => { attempts++; if (attempts === 1) throw Error("offline"); return { ok: true, json: async () => ({ frontendVersion: attempts === 2 ? "first" : "second" }) }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notice, undefined);
  await check!(); assert.equal(notice, undefined);
  await check!(); assert.equal(notice.id, "app-update"); assert.equal(reloads, 0);
  await check!(); assert.equal(attempts, 3);
  button.onclick(); assert.equal(reloads, 1);
});
