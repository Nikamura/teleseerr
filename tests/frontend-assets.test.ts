import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "test-token", SEERR_URL: "https://seerr.invalid", SEERR_API_KEY: "test", TELESEERR_ADMIN_USER_ID: "1" });
test("HTML identifies its exact frontend build and versions entry assets on deep routes", async () => {
  const { serveStatic, FRONTEND_VERSION } = await import("../src/http.js");
  let body = ""; let headers: any;
  const response = { writeHead: (_code: number, values: any) => { headers = values; }, end: (value: string) => { body = String(value); } } as unknown as ServerResponse;
  assert.equal(await serveStatic(response, "/"), true);
  assert.match(body, new RegExp(`name="app-version" content="${FRONTEND_VERSION}"`));
  for (const name of ["style.css", "facelift.css", "app.js"]) assert.ok(body.includes(`/${name}?v=${FRONTEND_VERSION}`));
  assert.match(headers["Cache-Control"], /no-store/);
  assert.equal(await serveStatic(response, "/tv/1421"), false);
});
