/**
 * Resource Guardian — periodic health check for browser resources.
 *
 * P0-F2/F3 (2026-03-28):
 *   - Windows: 改用 PowerShell Get-CimInstance Win32_Process 递归遍历完整进程树
 *   - 不再使用 wmic，不限层级
 *   - Guardian tracking mode 显式枚举，不再静默退化
 *
 * Tracking modes:
 *   tracking_active       — automation PID 已注册，guardian 按进程树计量
 *   tracking_unavailable  — browser 已启动但拿不到 PID，guardian 无法监控
 *   no_browser            — 当前无 automation browser 实例
 *   test_override         — 仅测试态，browserRss 由注入函数提供
 */

import { createChildLogger } from "../lib/logger.js";
import { getPageLifecycleTracker } from "./page-lifecycle.js";
import { execSync } from "node:child_process";

const log = createChildLogger({ module: "resource-guardian" });

/* ── Types ── */

export type GuardianTrackingMode =
  | "tracking_active"
  | "tracking_unavailable"
  | "no_browser"
  | "test_override";

export interface GuardianTrackingState {
  mode: GuardianTrackingMode;
  automationBrowserPid: number | null;
  /**
   * Cached value from the most recent _guardianTick() measurement.
   * This is NOT a real-time reading — it reflects the last completed tick.
   * After browser close, this may retain the last measured value.
   *
   * To determine whether a browser is currently running, use `mode` and
   * `automationBrowserPid` — do NOT rely on this field being 0 or non-0.
   */
  automationBrowserTreeRssBytes: number;
}

export interface ResourceGuardianConfig {
  checkIntervalMs: number;
  destroyThresholdBytes: number;
  maxConsecutiveOverThreshold: number;
}

function readGuardianConfig(): ResourceGuardianConfig {
  return {
    checkIntervalMs: parseInt(process.env.GUARDIAN_CHECK_INTERVAL_MS ?? "30000", 10),
    destroyThresholdBytes: parseInt(
      process.env.GUARDIAN_DESTROY_THRESHOLD_BYTES ?? String(3 * 1024 * 1024 * 1024), 10,
    ),
    maxConsecutiveOverThreshold: parseInt(
      process.env.GUARDIAN_MAX_CONSECUTIVE_OVER ?? "3", 10,
    ),
  };
}

/* ── State ── */

let guardianConfig: ResourceGuardianConfig | null = null;
let guardianTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveOver = 0;

let _closeBrowserFn: (() => Promise<void>) | null = null;

export function injectCloseBrowser(fn: () => Promise<void>): void {
  _closeBrowserFn = fn;
}

/* ── Automation Browser PID Tracking ── */

let _automationBrowserPid: number | null = null;
/**
 * Set to true when a browser has been launched but PID could not be obtained.
 * This lets the guardian distinguish "no browser" from "browser exists, PID unknown".
 */
let _browserLaunchedButPidUnavailable = false;

export function setAutomationBrowserPid(pid: number | null): void {
  const prev = _automationBrowserPid;
  _automationBrowserPid = pid;
  if (pid !== null) {
    _browserLaunchedButPidUnavailable = false;
    log.info({ prevPid: prev, newPid: pid }, "Automation browser PID registered");
  } else {
    log.info({ prevPid: prev }, "Automation browser PID cleared (browser closed)");
  }
}

/**
 * Call when browser launched successfully but PID could not be resolved.
 * This is distinct from "no browser" — guardian will report tracking_unavailable.
 */
export function markBrowserLaunchedPidUnavailable(): void {
  _browserLaunchedButPidUnavailable = true;
  _automationBrowserPid = null;
  log.warn("Browser launched but automation PID could not be resolved — guardian tracking unavailable");
}

/** Clear the "pid unavailable" flag when browser closes. */
export function clearBrowserLaunchedFlag(): void {
  _browserLaunchedButPidUnavailable = false;
}

export function getAutomationBrowserPid(): number | null {
  return _automationBrowserPid;
}

/* ── Process Tree RSS ── */

function getProcessTreeRssBytes(rootPid: number): number {
  if (process.platform === "win32") {
    return getProcessTreeRssWindows(rootPid);
  }
  return getProcessTreeRssUnix(rootPid);
}

/**
 * Windows: use PowerShell Get-CimInstance Win32_Process to get ALL processes,
 * build a ProcessId→children map in-memory, then recursively walk the tree
 * from rootPid summing WorkingSetSize. This handles arbitrary tree depth.
 */
function getProcessTreeRssWindows(rootPid: number): number {
  try {
    // Single PowerShell call: get ProcessId, ParentProcessId, WorkingSetSize for ALL processes.
    // Output as CSV for easy parsing.
    const psCmd = [
      "Get-CimInstance Win32_Process",
      "| Select-Object ProcessId, ParentProcessId, WorkingSetSize",
      "| ConvertTo-Csv -NoTypeInformation",
    ].join(" ");

    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "${psCmd}"`,
      { encoding: "utf-8", timeout: 8000, windowsHide: true },
    );

    // Parse CSV: first line is header ("ProcessId","ParentProcessId","WorkingSetSize")
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return 0;

    interface ProcInfo { pid: number; ppid: number; wss: number }
    const procs: ProcInfo[] = [];
    const childrenMap = new Map<number, number[]>();

    for (let i = 1; i < lines.length; i++) {
      // Parse CSV line: "pid","ppid","wss"
      const match = lines[i]!.match(/"(\d+)","(\d+)","(\d+)"/);
      if (!match) continue;
      const pid = parseInt(match[1]!, 10);
      const ppid = parseInt(match[2]!, 10);
      const wss = parseInt(match[3]!, 10);
      if (!Number.isFinite(pid)) continue;
      procs.push({ pid, ppid, wss: Number.isFinite(wss) ? wss : 0 });
      if (!childrenMap.has(ppid)) childrenMap.set(ppid, []);
      childrenMap.get(ppid)!.push(pid);
    }

    // Recursive walk from rootPid
    let totalBytes = 0;
    const visited = new Set<number>();

    function walk(p: number): void {
      if (visited.has(p)) return;
      visited.add(p);
      const info = procs.find((x) => x.pid === p);
      if (info) totalBytes += info.wss;
      const children = childrenMap.get(p);
      if (children) {
        for (const child of children) walk(child);
      }
    }

    walk(rootPid);
    return totalBytes;
  } catch (err) {
    log.debug({ err, rootPid }, "PowerShell process tree RSS query failed");
    return 0;
  }
}

function getProcessTreeRssUnix(rootPid: number): number {
  try {
    let allPids = `${rootPid}`;
    try {
      const descendants = execSync(
        `pgrep -P ${rootPid}`, { encoding: "utf-8", timeout: 3000 },
      ).trim();
      if (descendants) allPids += "," + descendants.split("\n").join(",");
    } catch { /* no children */ }

    const psOut = execSync(
      `ps -o rss= -p ${allPids}`, { encoding: "utf-8", timeout: 3000 },
    );
    let totalKB = 0;
    for (const line of psOut.split("\n")) {
      const kb = parseInt(line.trim(), 10);
      if (Number.isFinite(kb)) totalKB += kb;
    }
    return totalKB * 1024;
  } catch {
    return 0;
  }
}

/* ── Test Override ── */

let _browserRssOverride: (() => number) | null = null;

export function _testSetBrowserRssOverride(fn: (() => number) | null): void {
  _browserRssOverride = fn;
}

/* ── Tracking State ── */

/**
 * Cached RSS value from the last _guardianTick() measurement.
 * getGuardianTrackingState() returns this cached value to avoid
 * the PID-alive-check side effect of measureAutomationBrowserRss().
 */
let _lastMeasuredBrowserRssBytes = 0;

/**
 * Get the current guardian tracking state — used for structured logging and verification.
 *
 * automationBrowserTreeRssBytes is a CACHED value from the most recent
 * _guardianTick() call. It is 0 if no tick has ever run. After browser close,
 * it may still hold the last measured value — this is by design.
 *
 * To determine whether a browser is currently running, check:
 *   - mode === "tracking_active" → browser is alive and tracked
 *   - automationBrowserPid !== null → PID is known
 * Do NOT use automationBrowserTreeRssBytes to infer browser liveness.
 *
 * Does NOT call measureAutomationBrowserRss() directly to avoid
 * PID-alive-check side effects (which can clear a stale PID).
 */
export function getGuardianTrackingState(): GuardianTrackingState {
  const mode = resolveTrackingMode();
  return {
    mode,
    automationBrowserPid: _automationBrowserPid,
    automationBrowserTreeRssBytes: _lastMeasuredBrowserRssBytes,
  };
}

function resolveTrackingMode(): GuardianTrackingMode {
  if (_browserRssOverride) return "test_override";
  if (_automationBrowserPid !== null) return "tracking_active";
  if (_browserLaunchedButPidUnavailable) return "tracking_unavailable";
  return "no_browser";
}

function measureAutomationBrowserRss(): number {
  if (_browserRssOverride) return _browserRssOverride();
  if (_automationBrowserPid === null) return 0;

  // Verify PID is still alive
  try {
    process.kill(_automationBrowserPid, 0);
  } catch {
    log.info({ stalePid: _automationBrowserPid }, "Automation browser PID no longer alive — clearing");
    _automationBrowserPid = null;
    return 0;
  }

  return getProcessTreeRssBytes(_automationBrowserPid);
}

/* ── Guardian Tick ── */

export interface GuardianTickResult {
  nodeRssMB: number;
  automationBrowserTreeRssMB: number;
  fuseTripped: boolean;
  closeBrowserCalled: boolean;
  mode: GuardianTrackingMode;
}

export async function _guardianTick(): Promise<GuardianTickResult> {
  const cfg = guardianConfig ?? readGuardianConfig();
  const tracker = getPageLifecycleTracker();
  const stats = tracker.getStats();
  const nodeMem = process.memoryUsage();
  const mode = resolveTrackingMode();
  const automationBrowserRss = measureAutomationBrowserRss();
  _lastMeasuredBrowserRssBytes = automationBrowserRss;

  const nodeRssMB = Math.round(nodeMem.rss / 1024 / 1024);
  const automationBrowserTreeRssMB = Math.round(automationBrowserRss / 1024 / 1024);
  const thresholdMB = Math.round(cfg.destroyThresholdBytes / 1024 / 1024);

  log.info(
    {
      mode,
      nodeRssMB,
      automationBrowserTreeRssMB,
      automationBrowserPid: _automationBrowserPid,
      heapUsedMB: Math.round(nodeMem.heapUsed / 1024 / 1024),
      openPages: stats.openPages,
      closedPages: stats.closedPages,
      leakedPages: stats.leakedPages,
      highWaterMark: stats.highWaterMark,
      waiters: stats.acquireWaiters,
      openBySource: stats.openBySource,
      thresholdMB,
    },
    "Resource guardian health check",
  );

  let fuseTripped = false;
  let closeBrowserCalled = false;

  const isOver = automationBrowserRss > cfg.destroyThresholdBytes;

  if (isOver) {
    consecutiveOver++;
    log.warn(
      {
        mode,
        automationBrowserTreeRssMB,
        automationBrowserPid: _automationBrowserPid,
        thresholdMB,
        consecutiveOver,
        maxConsecutive: cfg.maxConsecutiveOverThreshold,
      },
      "Automation browser memory exceeds destroy threshold",
    );

    if (consecutiveOver >= cfg.maxConsecutiveOverThreshold) {
      log.error(
        {
          consecutiveOver,
          automationBrowserTreeRssMB,
          openPages: stats.openPages,
          action: "force_release_slots → close_browser → preserve_profile",
        },
        "FUSE BLOWN — forcing browser destroy to reclaim memory",
      );

      fuseTripped = true;
      tracker.forceReleaseAll("resource-guardian-fuse");

      if (_closeBrowserFn) {
        try {
          closeBrowserCalled = true;
          await _closeBrowserFn();
        } catch (err) {
          log.error({ err }, "Failed to close browser during guardian fuse");
        }
      }

      _automationBrowserPid = null;
      _browserLaunchedButPidUnavailable = false;
      consecutiveOver = 0;
    }
  } else {
    if (consecutiveOver > 0) {
      log.info(
        { previousConsecutiveOver: consecutiveOver, nodeRssMB, automationBrowserTreeRssMB },
        "Memory back under threshold",
      );
    }
    consecutiveOver = 0;
  }

  return { nodeRssMB, automationBrowserTreeRssMB, fuseTripped, closeBrowserCalled, mode };
}

/* ── Lifecycle ── */

export function startResourceGuardian(): void {
  if (guardianTimer) return;
  guardianConfig = readGuardianConfig();
  const mode = resolveTrackingMode();
  log.info(
    {
      checkIntervalMs: guardianConfig.checkIntervalMs,
      destroyThresholdMB: Math.round(guardianConfig.destroyThresholdBytes / 1024 / 1024),
      maxConsecutiveOver: guardianConfig.maxConsecutiveOverThreshold,
      platform: process.platform,
      memorySource: "automation_browser_pid_tree",
      mode,
    },
    "Resource guardian started",
  );
  guardianTimer = setInterval(() => {
    _guardianTick().catch((err) => log.error({ err }, "Guardian tick error"));
  }, guardianConfig.checkIntervalMs);
  if (guardianTimer && typeof guardianTimer === "object" && "unref" in guardianTimer) {
    guardianTimer.unref();
  }
}

export function stopResourceGuardian(): void {
  if (guardianTimer) {
    clearInterval(guardianTimer);
    guardianTimer = null;
    consecutiveOver = 0;
    guardianConfig = null;
    log.info("Resource guardian stopped");
  }
}

export function _testResetGuardian(): void {
  stopResourceGuardian();
  consecutiveOver = 0;
  _automationBrowserPid = null;
  _browserLaunchedButPidUnavailable = false;
  _browserRssOverride = null;
  _closeBrowserFn = null;
  _lastMeasuredBrowserRssBytes = 0;
}
