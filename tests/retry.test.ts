import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetryQueue } from "../src/retry.js";
import { NotificationDelivery } from "../src/notification-delivery.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "teleseerr-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 0;
  let posts = 0;
  let notices = 0;
  let linked = true;
  let status = 4;
  const errors: unknown[] = [];
  const deps = {
    now: () => now,
    inspect: async (_id: number) => ({ status, requestedBy: { id: 7 } }),
    linked: () => linked,
    retry: async (_id: number) => {
      posts++;
    },
    exhausted: async () => {
      notices++;
    },
    report: (error: unknown) => {
      errors.push(error);
    },
  };
  const file = join(dir, "retries.json");
  const queue = new RetryQueue(file, [1, 2, 3], deps);
  return {
    queue,
    deps,
    file,
    errors,
    advance: () => {
      now += 10000;
    },
    posts: () => posts,
    notices: () => notices,
    unlink: () => {
      linked = false;
    },
    setStatus: (value: number) => {
      status = value;
    },
  };
}

test("duplicate events and overlapping ticks produce one retry", async (t) => {
  const f = fixture(t);
  assert.equal(f.queue.enqueue(1, 7), true);
  assert.equal(f.queue.enqueue(1, 7), false);
  f.advance();
  await Promise.all([f.queue.tick(), f.queue.tick()]);
  assert.equal(f.posts(), 1);
});

test("pending work resumes and exhaustion survives restart and duplicate events", async (t) => {
  const f = fixture(t);
  f.queue.enqueue(1, 7);
  let queue = new RetryQueue(f.file, [1, 2, 3], f.deps);
  for (let i = 0; i < 3; i++) {
    f.advance();
    await queue.tick();
  }
  assert.equal(f.posts(), 3);
  assert.equal(f.notices(), 1);
  queue = new RetryQueue(f.file, [1, 2, 3], f.deps);
  assert.equal(queue.enqueue(1, 7), false);
  f.advance();
  await queue.tick();
  assert.equal(f.posts(), 3);
});

test("unlinked, declined, deleted and approved requests are not retried", async (t) => {
  for (const state of ["unlinked", "declined", "deleted", "approved"] as const) {
    const f = fixture(t);
    f.queue.enqueue(1, 7);
    if (state === "unlinked") f.unlink();
    if (state === "declined") f.setStatus(3);
    if (state === "approved") f.setStatus(2);
    if (state === "deleted") f.deps.inspect = async () => null as never;
    f.advance();
    await f.queue.tick();
    assert.equal(f.posts(), 0, state);
  }
});

test("cancellation during lookup prevents POST", async (t) => {
  const f = fixture(t);
  f.deps.inspect = async () => {
    f.queue.cancel(1);
    return { status: 4, requestedBy: { id: 7 } };
  };
  f.queue.enqueue(1, 7);
  f.advance();
  await f.queue.tick();
  assert.equal(f.posts(), 0);
});

test("retry and Telegram errors are caught and bounded", async (t) => {
  const f = fixture(t);
  f.deps.retry = async () => {
    throw new Error("Seerr offline");
  };
  f.deps.exhausted = async () => {
    throw new Error("Telegram offline");
  };
  f.queue.enqueue(1, 7);
  for (let i = 0; i < 5; i++) {
    f.advance();
    await f.queue.tick();
  }
  assert.equal(f.errors.length, 4);
  assert.equal(f.queue.enqueue(1, 7), false);
});

test("inspection outages use bounded budget without posting", async (t) => {
  const f = fixture(t);
  f.deps.inspect = async () => {
    throw new Error("timeout");
  };
  f.queue.enqueue(1, 7);
  for (let i = 0; i < 5; i++) {
    f.advance();
    await f.queue.tick();
  }
  assert.equal(f.errors.length, 3);
  assert.equal(f.posts(), 0);
  assert.equal(f.queue.enqueue(1, 7), false);
});

test("retry budget is persisted before the network request", async (t) => {
  const f = fixture(t);
  f.deps.retry = async () => {
    assert.equal(JSON.parse(readFileSync(f.file, "utf8"))[0].attempts, 1);
  };
  f.queue.enqueue(1, 7);
  f.advance();
  await f.queue.tick();
});

test("corrupt state fails closed", (t) => {
  const f = fixture(t);
  writeFileSync(f.file, "{bad json");
  assert.throws(() => new RetryQueue(f.file, [1], f.deps));
  writeFileSync(f.file, '[{"id":1}]');
  assert.throws(() => new RetryQueue(f.file, [1], f.deps));
});

test("lowering configured budget does not grant extra retries", async (t) => {
  const f = fixture(t);
  f.queue.enqueue(1, 7);
  f.advance();
  await f.queue.tick();
  const queue = new RetryQueue(f.file, [1], f.deps);
  f.advance();
  await queue.tick();
  assert.equal(f.posts(), 1);
});

test("concurrent approval notifications deduplicate and failed delivery can recover", async () => {
  const delivery = new NotificationDelivery();
  let sent = 0;
  const send = async () => {
    sent++;
  };
  await Promise.all([delivery.send("1:approved", send), delivery.send("1:approved", send)]);
  await delivery.send("1:approved", send);
  assert.equal(sent, 1);
  await assert.rejects(
    delivery.send("2:approved", async () => {
      throw new Error("offline");
    }),
  );
  await delivery.send("2:approved", send);
  assert.equal(sent, 2);
});
