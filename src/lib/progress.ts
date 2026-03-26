/**
 * Real-time progress tracker — singleton shared between scraper and API.
 *
 * Progress flows:
 *   idle → initializing → checking_session → scraping_page(1..N) →
 *   parsing_details(1..M) → ats_enhancement → dedup_insert → completed | error
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

export interface ProgressState {
  stage: ProgressStage;
  /** Current step within the stage (e.g., page 2 of 3) */
  current: number;
  /** Total expected steps in the stage */
  total: number;
  /** Overall percentage 0-100 */
  percent: number;
  /** Human-readable message */
  message: string;
  /** Current keyword being processed */
  keyword: string;
  /** Timestamp of last update */
  updatedAt: number;
  /** Accumulated stats for this run */
  stats: RunStats;
}

export interface RunStats {
  pagesScraped: number;
  jobsParsed: number;
  jobsInserted: number;
  jobsSkipped: number;
  errors: number;
}

const emitter = new EventEmitter();

let state: ProgressState = createIdleState();

function createIdleState(): ProgressState {
  return {
    stage: "idle",
    current: 0,
    total: 0,
    percent: 0,
    message: "Ready",
    keyword: "",
    updatedAt: Date.now(),
    stats: { pagesScraped: 0, jobsParsed: 0, jobsInserted: 0, jobsSkipped: 0, errors: 0 },
  };
}

export function getProgress(): Readonly<ProgressState> {
  return { ...state };
}

export function resetProgress(): void {
  state = createIdleState();
  emitter.emit("progress", state);
}

export function updateProgress(patch: Partial<Omit<ProgressState, "updatedAt">>): void {
  state = { ...state, ...patch, updatedAt: Date.now() };
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
