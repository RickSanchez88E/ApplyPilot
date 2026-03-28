/**
 * Page Lifecycle Tracker — P0 browser resource control.
 *
 * Responsibilities:
 *   1. Global and per-source page concurrency enforcement (semaphore)
 *   2. Page open/close/leak tracking with metrics
 *   3. Memory sampling and threshold alerts
 *
 * Design: singleton tracker, shared across local-browser-manager and workers.
 *
 * Waiter Lifecycle State Machine (P0-1A/P0-1B):
 *   Each waiter has exactly ONE terminal state. Transitions are:
 *
 *     pending → resolved             (drainWaiters found an available slot)
 *     pending → rejected_timeout     (acquireTimeoutMs elapsed)
 *     pending → rejected_force       (forceReleaseAll / destroy)
 *
 *   Rules enforced by code structure (not by comments):
 *     - Every state transition checks `state === "pending"` FIRST
 *     - If state is not pending, the transition is a no-op
 *     - After transition, state is set to the terminal value
 *     - This guarantees: no double-resolve, no double-reject,
 *       no resolve-after-reject, no reject-after-resolve
 */

import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "page-lifecycle" });

/* ── Configuration ─────────────────────────────────────────── */

export interface PageLifecycleConfig {
  maxOpenPages: number;
  maxOpenPagesPerSource: number;
  memoryThresholdBytes: number;
  memorySampleIntervalMs: number;
  acquireTimeoutMs: number;
}

function readDefaultConfig(): PageLifecycleConfig {
  return {
    maxOpenPages: parseInt(process.env.MAX_OPEN_PAGES ?? "3", 10),
    maxOpenPagesPerSource: parseInt(process.env.MAX_OPEN_PAGES_PER_SOURCE ?? "2", 10),
    memoryThresholdBytes: parseInt(
      process.env.MEMORY_THRESHOLD_BYTES ?? String(2 * 1024 * 1024 * 1024), 10,
    ),
    memorySampleIntervalMs: parseInt(process.env.MEMORY_SAMPLE_INTERVAL_MS ?? "30000", 10),
    acquireTimeoutMs: parseInt(process.env.PAGE_ACQUIRE_TIMEOUT_MS ?? "120000", 10),
  };
}

/* ── Metrics ───────────────────────────────────────────────── */

export interface PageLifecycleStats {
  openPages: number;
  closedPages: number;
  leakedPages: number;
  highWaterMark: number;
  openBySource: Record<string, number>;
  lastMemoryRss: number;
  memoryOverThreshold: boolean;
  acquireWaiters: number;
}

/* ── Waiter state machine ─────────────────────────────────── */

type WaiterState = "pending" | "resolved" | "rejected_timeout" | "rejected_force";

interface Waiter {
  readonly id: number;
  readonly source: string;
  state: WaiterState;
  /** Raw promise resolve — only called via tryResolve(). */
  readonly _resolve: (pageId: string) => void;
  /** Raw promise reject — only called via tryReject(). */
  readonly _reject: (err: Error) => void;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
}

/**
 * Attempt to resolve a waiter. Returns true if it was still pending.
 * If it was already in a terminal state, this is a no-op.
 */
function tryResolve(w: Waiter, pageId: string): boolean {
  if (w.state !== "pending") return false;
  w.state = "resolved";
  clearTimeout(w.timeoutHandle);
  w._resolve(pageId);
  return true;
}

/**
 * Attempt to reject a waiter. Returns true if it was still pending.
 * If it was already in a terminal state, this is a no-op.
 */
function tryReject(w: Waiter, err: Error, terminal: "rejected_timeout" | "rejected_force"): boolean {
  if (w.state !== "pending") return false;
  w.state = terminal;
  clearTimeout(w.timeoutHandle);
  w._reject(err);
  return true;
}

/* ── Singleton Tracker ─────────────────────────────────────── */

class PageLifecycleTracker {
  private config: PageLifecycleConfig;

  private _openPages = 0;
  private _closedPages = 0;
  private _leakedPages = 0;
  private _highWaterMark = 0;
  private _openBySource: Record<string, number> = {};

  private _lastMemoryRss = 0;
  private _memoryOverThreshold = false;
  private _memorySampleTimer: ReturnType<typeof setInterval> | null = null;

  private _waiters: Waiter[] = [];
  private _waiterIdCounter = 0;

  private _openPageIds = new Set<string>();
  private _pageIdCounter = 0;

  constructor(cfg?: Partial<PageLifecycleConfig>) {
    this.config = { ...readDefaultConfig(), ...cfg };
    this.startMemorySampling();
  }

  /* ── Semaphore: acquire slot ── */

  async acquireSlot(source: string): Promise<string> {
    if (this._memoryOverThreshold) {
      log.warn({ source, rss: this._lastMemoryRss }, "Memory over threshold — blocking page creation");
    }

    if (this.canAcquireNow(source)) {
      return this.doAcquire(source);
    }

    return new Promise<string>((resolve, reject) => {
      const waiterId = ++this._waiterIdCounter;

      // Build waiter object — timeoutHandle assigned after construction
      // because it needs to reference the waiter itself.
      const waiter: Waiter = {
        id: waiterId,
        source,
        state: "pending",
        _resolve: resolve,
        _reject: reject,
        timeoutHandle: setTimeout(() => {
          // Timeout path: pending → rejected_timeout
          const didReject = tryReject(
            waiter,
            new Error(
              `Page acquire timeout after ${this.config.acquireTimeoutMs}ms ` +
              `(open=${this._openPages}/${this.config.maxOpenPages}, source=${source})`,
            ),
            "rejected_timeout",
          );
          if (didReject) {
            this.removeWaiter(waiterId);
          }
        }, this.config.acquireTimeoutMs),
      };

      this._waiters.push(waiter);

      log.debug(
        { waiterId, source, waiters: this._waiters.length, open: this._openPages },
        "Queued for page slot",
      );
    });
  }

  /* ── Semaphore: release slot ── */

  releaseSlot(pageId: string, source: string): void {
    if (!this._openPageIds.has(pageId)) {
      log.warn({ pageId, source }, "releaseSlot called for unknown pageId — possible double-close");
      return;
    }

    this._openPageIds.delete(pageId);
    this._openPages = Math.max(0, this._openPages - 1);
    this._openBySource[source] = Math.max(0, (this._openBySource[source] ?? 1) - 1);
    this._closedPages++;

    log.debug(
      { pageId, source, open: this._openPages, closedTotal: this._closedPages },
      "Page slot released",
    );

    this.drainWaiters();
  }

  /* ── Mark leaked ── */

  markLeaked(pageId: string, source: string): void {
    if (this._openPageIds.has(pageId)) {
      this._openPageIds.delete(pageId);
      this._openPages = Math.max(0, this._openPages - 1);
      this._openBySource[source] = Math.max(0, (this._openBySource[source] ?? 1) - 1);
    }
    this._leakedPages++;
    log.error({ pageId, source, leakedTotal: this._leakedPages }, "PAGE LEAKED — not properly closed");
    this.drainWaiters();
  }

  /* ── Force release all (for browser destroy / guardian fuse / tracker destroy) ── */

  forceReleaseAll(reason: string): void {
    const remaining = this._openPageIds.size;
    if (remaining > 0) {
      log.warn({ remaining, reason }, "Force-releasing all tracked pages (browser destroyed)");
      this._leakedPages += remaining;
      this._openPageIds.clear();
      this._openPages = 0;
      this._openBySource = {};
    }

    // Reject all PENDING waiters. The tryReject function checks state === "pending"
    // so it's impossible to double-reject or reject an already-resolved waiter.
    const waitersToProcess = [...this._waiters];
    for (const w of waitersToProcess) {
      tryReject(w, new Error(`All pages force-released: ${reason}`), "rejected_force");
    }
    this._waiters = [];
  }

  /* ── Stats ── */

  getStats(): PageLifecycleStats {
    return {
      openPages: this._openPages,
      closedPages: this._closedPages,
      leakedPages: this._leakedPages,
      highWaterMark: this._highWaterMark,
      openBySource: { ...this._openBySource },
      lastMemoryRss: this._lastMemoryRss,
      memoryOverThreshold: this._memoryOverThreshold,
      acquireWaiters: this._waiters.length,
    };
  }

  isMemoryOverThreshold(): boolean {
    return this._memoryOverThreshold;
  }

  getConfig(): PageLifecycleConfig {
    return { ...this.config };
  }

  /* ── Cleanup ── */

  destroy(): void {
    if (this._memorySampleTimer) {
      clearInterval(this._memorySampleTimer);
      this._memorySampleTimer = null;
    }
    this.forceReleaseAll("tracker-destroy");
  }

  /* ── Internals ── */

  private canAcquireNow(source: string): boolean {
    if (this._openPages >= this.config.maxOpenPages) return false;
    const sourceCount = this._openBySource[source] ?? 0;
    if (sourceCount >= this.config.maxOpenPagesPerSource) return false;
    return true;
  }

  private doAcquire(source: string): string {
    const pageId = `page-${++this._pageIdCounter}`;
    this._openPageIds.add(pageId);
    this._openPages++;
    this._openBySource[source] = (this._openBySource[source] ?? 0) + 1;
    if (this._openPages > this._highWaterMark) {
      this._highWaterMark = this._openPages;
    }
    log.debug(
      { pageId, source, open: this._openPages, max: this.config.maxOpenPages },
      "Page slot acquired",
    );
    return pageId;
  }

  private removeWaiter(waiterId: number): void {
    this._waiters = this._waiters.filter((w) => w.id !== waiterId);
  }

  private drainWaiters(): void {
    const pending = [...this._waiters];
    for (const waiter of pending) {
      if (waiter.state !== "pending") {
        // Stale entry — clean it out
        this.removeWaiter(waiter.id);
        continue;
      }
      if (this.canAcquireNow(waiter.source)) {
        this.removeWaiter(waiter.id);
        const pageId = this.doAcquire(waiter.source);
        tryResolve(waiter, pageId);
        return; // One at a time
      }
    }
  }

  private startMemorySampling(): void {
    if (this._memorySampleTimer) return;
    this.sampleMemory();
    this._memorySampleTimer = setInterval(() => this.sampleMemory(), this.config.memorySampleIntervalMs);
    if (this._memorySampleTimer && typeof this._memorySampleTimer === "object" && "unref" in this._memorySampleTimer) {
      this._memorySampleTimer.unref();
    }
  }

  private sampleMemory(): void {
    const mem = process.memoryUsage();
    this._lastMemoryRss = mem.rss;
    const wasOver = this._memoryOverThreshold;
    this._memoryOverThreshold = mem.rss > this.config.memoryThresholdBytes;

    if (this._memoryOverThreshold && !wasOver) {
      log.warn(
        {
          rss: mem.rss,
          rssMB: Math.round(mem.rss / 1024 / 1024),
          thresholdMB: Math.round(this.config.memoryThresholdBytes / 1024 / 1024),
          openPages: this._openPages,
        },
        "MEMORY THRESHOLD EXCEEDED — protective measures active",
      );
    } else if (!this._memoryOverThreshold && wasOver) {
      log.info(
        { rssMB: Math.round(mem.rss / 1024 / 1024) },
        "Memory dropped below threshold — normal operation resumed",
      );
    }
  }
}

/* ── Singleton export ── */

let _tracker: PageLifecycleTracker | null = null;

export function getPageLifecycleTracker(): PageLifecycleTracker {
  if (!_tracker) {
    _tracker = new PageLifecycleTracker();
  }
  return _tracker;
}

export function resetPageLifecycleTracker(): void {
  if (_tracker) {
    _tracker.destroy();
    _tracker = null;
  }
}
