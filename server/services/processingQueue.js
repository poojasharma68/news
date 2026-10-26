/**
 * In-process job queue with bounded concurrency, bounded exponential-backoff retries for
 * transient failures, and cancellation of jobs that have not started. Every article is an
 * independent job: a failure never affects other jobs. Job state is persisted on the card row,
 * so queued work is recovered after a restart (see NewsService.recover).
 */
import { randomUUID } from "node:crypto";
import { toPipelineError } from "../lib/errors.js";

export class ProcessingQueue {
  pending = [];
  active = new Map();
  waiting = new Map();
  idleResolvers = [];
  stopped = false;

  constructor(options) {
    this.options = options;
  }

  /** Adds a job unless the same card is already pending, running or waiting to retry. */
  enqueue(cardId, mode = "full") {
    if (this.stopped || this.has(cardId)) return false;
    // jobId correlates every attempt, event and log line of this job.
    this.pending.push({ cardId, mode, attempt: 1, jobId: randomUUID() });
    queueMicrotask(() => this.pump());
    return true;
  }

  has(cardId) {
    return (
      this.active.has(cardId) ||
      this.waiting.has(cardId) ||
      this.pending.some((t) => t.cardId === cardId)
    );
  }

  /** Cancels a job that has not started (or is waiting to retry). Running jobs are not interrupted. */
  cancel(cardId) {
    const index = this.pending.findIndex((t) => t.cardId === cardId);
    if (index >= 0) {
      this.pending.splice(index, 1);
      this.checkIdle();
      return "cancelled";
    }
    const waiting = this.waiting.get(cardId);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.waiting.delete(cardId);
      this.checkIdle();
      return "cancelled";
    }
    return this.active.has(cardId) ? "running" : "not_found";
  }

  get stats() {
    return {
      pending: this.pending.length,
      active: this.active.size,
      waitingRetry: this.waiting.size,
    };
  }

  /** Resolves when no job is pending, running or waiting to retry. */
  onIdle() {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  stop() {
    this.stopped = true;
    for (const { timer } of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
    this.pending.length = 0;
    this.checkIdle();
  }

  isIdle() {
    return (
      this.pending.length === 0 &&
      this.active.size === 0 &&
      this.waiting.size === 0
    );
  }

  checkIdle() {
    if (!this.isIdle()) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }

  pump() {
    while (
      !this.stopped &&
      this.active.size < this.options.concurrency &&
      this.pending.length > 0
    ) {
      const task = this.pending.shift();
      this.active.set(task.cardId, task);
      void this.execute(task);
    }
    this.checkIdle();
  }

  retryDelay(attempt) {
    const base = this.options.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.round(Math.random() * this.options.baseDelayMs * 0.25);
    return Math.min(base + jitter, this.options.maxDelayMs ?? 60_000);
  }

  async execute(task) {
    const maxAttempts = this.options.maxRetries + 1;
    try {
      await this.options.run(task, { attempt: task.attempt, maxAttempts });
    } catch (err) {
      const error = toPipelineError(err);
      if (error.retryable && task.attempt < maxAttempts && !this.stopped) {
        const delay = this.retryDelay(task.attempt);
        this.options.logger?.warn("Job failed, retry scheduled", {
          cardId: task.cardId,
          jobId: task.jobId,
          attempt: task.attempt,
          code: error.code,
          delay,
        });
        try {
          await this.options.onRetry?.(task, error, delay);
        } catch (hookError) {
          this.options.logger?.error("onRetry hook failed", {
            cardId: task.cardId,
            error: hookError,
          });
        }
        // Scheduled only after the hook so the timer can never fire while this run is still active.
        const next = { ...task, attempt: task.attempt + 1 };
        const timer = setTimeout(() => {
          this.waiting.delete(task.cardId);
          if (this.stopped) return this.checkIdle();
          this.pending.push(next);
          this.pump();
        }, delay);
        timer.unref?.();
        this.waiting.set(task.cardId, { task: next, timer });
      } else {
        this.options.logger?.warn("Job failed", {
          cardId: task.cardId,
          jobId: task.jobId,
          attempt: task.attempt,
          code: error.code,
          message: error.message,
        });
        try {
          await this.options.onFailure(task, error);
        } catch (hookError) {
          this.options.logger?.error("onFailure hook failed", {
            cardId: task.cardId,
            error: hookError,
          });
        }
      }
    } finally {
      this.active.delete(task.cardId);
      this.pump();
    }
  }
}
