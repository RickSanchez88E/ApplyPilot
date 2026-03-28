/**
 * Real-time progress tracker — singleton shared between scraper and API.
 *
 * Progress flows:
 *   idle → initializing → checking_session → scraping_page(1..N) →
 *   parsing_details(1..M) → ats_enhancement → dedup_insert → completed | error
 *
 * Includes a rolling activity log so the frontend can show detailed steps.
 */

import { EventEmitter } from "node:events";

export type ProgressStage =
  | "idle"
  | "initializing"
  | "checking_session"
  | "scraping_page"
  | "parsing_details"
  | "ats_enhancement"
  | "dedup_insert"
  | "completed"
  | "error";

export interface ProgressLogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "success";
  msg: string;
}

export interface ProgressState {
  /**
   * Logical source currently producing this progress stream.
   * Empty string means "not scoped".
   */
  source: string;
  stage: ProgressStage;
  current: number;
  total: number;
  percent: number;
  message: string;
  keyword: string;
  updatedAt: number;
  stats: RunStats;
  /** Rolling activity log (newest last, capped at MAX_LOG_ENTRIES) */
  logs: ProgressLogEntry[];
}

export interface RunStats {
  pagesScraped: number;
  jobsParsed: number;
  jobsInserted: number;
  jobsSkipped: number;
  errors: number;
}

const MAX_LOG_ENTRIES = 80;
const emitter = new EventEmitter();

let state: ProgressState = createIdleState();

function createIdleState(): ProgressState {
  return {
    source: "",
    stage: "idle",
    current: 0,
    total: 0,
    percent: 0,
    message: "Ready",
    keyword: "",
    updatedAt: Date.now(),
    stats: { pagesScraped: 0, jobsParsed: 0, jobsInserted: 0, jobsSkipped: 0, errors: 0 },
    logs: [],
  };
}

export function getProgress(): Readonly<ProgressState> {
  return { ...state };
}

export function resetProgress(): void {
  state = createIdleState();
  emitter.emit("progress", state);
}

export function updateProgress(patch: Partial<Omit<ProgressState, "updatedAt" | "logs">>): void {
  state = { ...state, ...patch, updatedAt: Date.now() };
  emitter.emit("progress", state);
}

/** Append a human-readable log entry + optionally update message/stage. */
export function appendLog(
  level: ProgressLogEntry["level"],
  msg: string,
  patch?: Partial<Omit<ProgressState, "updatedAt" | "logs">>,
): void {
  const entry: ProgressLogEntry = { ts: Date.now(), level, msg };
  const logs = [...state.logs, entry].slice(-MAX_LOG_ENTRIES);
  state = { ...state, ...patch, logs, message: msg, updatedAt: Date.now() };
  emitter.emit("progress", state);
}

export function updateStats(patch: Partial<RunStats>): void {
  state = {
    ...state,
    stats: { ...state.stats, ...patch },
    updatedAt: Date.now(),
  };
  emitter.emit("progress", state);
}

export function incrementStat(key: keyof RunStats, amount = 1): void {
  state = {
    ...state,
    stats: { ...state.stats, [key]: state.stats[key] + amount },
    updatedAt: Date.now(),
  };
  emitter.emit("progress", state);
}

export function onProgress(listener: (state: ProgressState) => void): void {
  emitter.on("progress", listener);
}

export function offProgress(listener: (state: ProgressState) => void): void {
  emitter.off("progress", listener);
}
