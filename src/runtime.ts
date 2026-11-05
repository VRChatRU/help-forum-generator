import { appendFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

type Fields = Record<string, unknown>;
type Level = "info" | "warn" | "error";
export type Logger = Record<Level, (message: string, fields?: Fields) => void>;

export function createLogger(path: string, secrets: readonly string[]): Logger {
  const sensitive = [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  let fileFailed = false;

  function write(level: Level, message: string, fields?: Fields) {
    const line = JSON.stringify(
      { time: new Date().toISOString(), level, message, fields },
      (_key, value: unknown) => {
        if (typeof value === "string") {
          let redacted = value;
          for (const secret of sensitive)
            redacted = redacted.replaceAll(secret, "[REDACTED]");
          return redacted;
        }
        if (value instanceof Error)
          return {
            name: value.name,
            message: value.message,
            code: "code" in value ? value.code : undefined,
          };
        if (typeof value === "bigint") return value.toString();
        return value;
      },
    );

    console[level](line);
    try {
      appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      fileFailed = false;
    } catch {
      if (!fileFailed)
        console.error("Could not write the help-forum-generator log");
      fileFailed = true;
    }
  }

  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

const minute = 60_000;

export async function runHeartbeat(
  url: URL,
  signal: AbortSignal,
): Promise<void> {
  let next = performance.now() + minute;
  while (!signal.aborted) {
    await wait(Math.max(0, Math.ceil(next - performance.now())), undefined, {
      signal,
    }).catch(() => {});
    if (signal.aborted) return;

    next = performance.now() + minute;
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      await response.body?.cancel();
    } catch {
      // The monitor detects missed pulses. The next pulse uses the normal interval.
    }
  }
}

export function retryDelay(attempt: number): number {
  return Math.min(minute, 2_000 * 2 ** Math.min(attempt - 1, 5));
}

type Job = {
  key: string;
  priority: number;
  needsDiscord: boolean;
  run: () => Promise<void>;
  attempts: number;
  due: number;
};

export class WorkQueue {
  private readonly jobs = new Map<string, Job>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private connected = false;
  private stopped = false;

  constructor(private readonly log: Logger) {}

  enqueue(
    key: string,
    priority: number,
    run: Job["run"],
    needsDiscord = true,
  ): void {
    if (this.stopped) return;
    this.jobs.set(key, {
      key,
      priority,
      needsDiscord,
      run,
      attempts: 0,
      due: performance.now(),
    });
    this.schedule();
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) {
      const now = performance.now();
      for (const job of this.jobs.values()) if (job.needsDiscord) job.due = now;
    }
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.jobs.clear();
    clearTimeout(this.timer);
    await this.active;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped || this.active || this.jobs.size === 0) return;

    const now = performance.now();
    let selected: Job | undefined;
    let next = Infinity;
    for (const job of this.jobs.values()) {
      if (job.needsDiscord && !this.connected) continue;
      next = Math.min(next, job.due);
      if (job.due <= now && (!selected || job.priority < selected.priority))
        selected = job;
    }
    if (next === Infinity) return;

    this.timer = setTimeout(
      () => {
        if (!selected) {
          this.schedule();
          return;
        }
        this.jobs.delete(selected.key);
        const job = selected;
        this.active = Promise.resolve()
          .then(() => this.execute(job))
          .finally(() => {
            this.active = undefined;
            this.schedule();
          });
      },
      Math.max(0, Math.ceil(next - now)),
    );
  }

  private async execute(job: Job): Promise<void> {
    try {
      await job.run();
      if (job.attempts > 0)
        this.log.info("Job completed after a retry", { job: job.key });
    } catch (error) {
      if (this.stopped) return;
      if (job.attempts === 0)
        this.log.warn("Job failed and will be retried", {
          job: job.key,
          error,
        });
      job.attempts += 1;
      job.due = performance.now() + retryDelay(job.attempts);
      if (!this.jobs.has(job.key)) this.jobs.set(job.key, job);
    }
  }
}
