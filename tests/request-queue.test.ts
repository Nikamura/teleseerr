import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("web/request-queue.js"), "utf8");
const queueModule = import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as Promise<{
  createRequestQueue: (limit?: number) => <T>(work: () => Promise<T>) => Promise<T>;
}>;

test("all seven home-page requests finish with at most two active requests", async () => {
  const { createRequestQueue } = await queueModule;
  const enqueue = createRequestQueue();
  let active = 0;
  let peak = 0;
  const results = await Promise.all(Array.from({ length: 7 }, (_, id) => enqueue(async () => {
    active++;
    peak = Math.max(peak, active);
    assert(active <= 2, "server would return 429");
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return id;
  })));
  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6]);
});

test("failed reads release their slot and do not block subsequent mutations", async () => {
  const { createRequestQueue } = await queueModule;
  const enqueue = createRequestQueue(1);
  const failed = enqueue(async () => { throw new Error("read failed"); });
  const mutation = enqueue(async () => "created");
  await assert.rejects(failed, /read failed/);
  assert.equal(await mutation, "created");
});
