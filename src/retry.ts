import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type RetryJob = {
  id: number;
  userId: number;
  attempts: number;
  due: number | null;
  stopped: boolean;
};

type Dependencies = {
  inspect: (id: number) => Promise<{ status: number; requestedBy: { id: number } } | null>;
  linked: (userId: number) => boolean;
  retry: (id: number) => Promise<void>;
  exhausted: (job: RetryJob) => Promise<void>;
  report: (error: unknown) => void;
  now?: () => number;
};

// One worker per data directory. Keep tombstones: duplicate events must never reset a budget.
export class RetryQueue {
  private jobs: RetryJob[] = [];
  private running = false;
  private readonly now: () => number;

  constructor(
    private readonly file: string,
    private readonly delays: readonly number[],
    private readonly deps: Dependencies,
  ) {
    this.now = deps.now ?? Date.now;
    if (existsSync(file)) {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(raw) || raw.length > 10_000 || !raw.every(isJob)) {
        throw new Error("Invalid retry state; restore it before enabling retries");
      }
      this.jobs = raw;
    }
  }

  private save(job: RetryJob): void {
    const next = this.jobs.filter((item) => item.id !== job.id).concat(job);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600, flush: true });
    renameSync(`${this.file}.tmp`, this.file);
    this.jobs = next;
  }

  enqueue(id: number, userId: number): boolean {
    const existing = this.jobs.find((job) => job.id === id);
    if (existing?.stopped || existing?.due != null) return false;
    if (!existing && this.jobs.length >= 10_000) {
      throw new Error("Retry ledger full; automatic retries paused for new requests");
    }
    const attempts = existing?.attempts ?? 0;
    const delay = this.delays[attempts];
    if (delay === undefined) return false;
    this.save({ id, userId, attempts, due: this.now() + delay * 1000, stopped: false });
    return true;
  }

  cancel(id: number): void {
    const job = this.jobs.find((item) => item.id === id);
    if (job) this.save({ ...job, stopped: true, due: null });
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Bound each pass and serialize work, including overlapping timer callbacks.
      const due = this.jobs
        .filter((job) => !job.stopped && job.due !== null && job.due <= this.now())
        .slice(0, 20);
      for (const job of due) await this.run(job);
    } catch (error) {
      this.deps.report(error);
    } finally {
      this.running = false;
    }
  }

  private async run(original: RetryJob): Promise<void> {
    if (this.jobs.find((job) => job.id === original.id) !== original) return;
    if (original.attempts >= this.delays.length) {
      this.cancel(original.id);
      return;
    }
    // Persist consumption before any network operation; a crash cannot replay this attempt.
    const attempt = { ...original, attempts: original.attempts + 1 };
    const nextDelay = this.delays[attempt.attempts];
    const state = {
      ...attempt,
      due: nextDelay === undefined ? null : this.now() + nextDelay * 1000,
    };
    this.save(state);
    try {
      const request = await this.deps.inspect(state.id);
      if (this.jobs.find((job) => job.id === state.id) !== state) return;
      if (request?.requestedBy.id !== state.userId || !this.deps.linked(state.userId)) {
        this.cancel(state.id);
        return;
      }
      if (request.status !== 4) {
        // Approved requests may later fail again; retain their consumed budget.
        this.save({ ...state, due: null, stopped: request.status !== 2 });
        return;
      }
      await this.deps.retry(state.id);
    } catch (error) {
      this.deps.report(error);
    }
    if (this.jobs.find((job) => job.id === state.id) !== state) return;
    if (nextDelay === undefined) {
      this.save({ ...state, stopped: true, due: null });
      // This reports the exhausted budget, not that the last accepted retry failed.
      try {
        await this.deps.exhausted(state);
      } catch (error) {
        this.deps.report(error);
      }
    }
  }
}

function isJob(value: unknown): value is RetryJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(job["id"]) &&
    Number(job["id"]) > 0 &&
    Number.isSafeInteger(job["userId"]) &&
    Number(job["userId"]) > 0 &&
    Number.isSafeInteger(job["attempts"]) &&
    Number(job["attempts"]) >= 0 &&
    (job["due"] === null || (typeof job["due"] === "number" && Number.isFinite(job["due"]))) &&
    typeof job["stopped"] === "boolean"
  );
}
