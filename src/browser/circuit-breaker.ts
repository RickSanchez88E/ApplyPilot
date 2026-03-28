import { getRedisConnection } from "../lib/redis.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "circuit-breaker" });

export interface BreakerConfig {
  maxFailures: number;
  cooldownMs: number;
}

const DEFAULT_CONFIG: BreakerConfig = { maxFailures: 3, cooldownMs: 30 * 60 * 1000 };

const BREAKER_PREFIX = "breaker:";

export type FailureType = "cf_block" | "login_failure" | "tunnel_failure" | "timeout" | "parse_error";

export interface BreakerState {
  source: string;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  cooldownUntil: string | null;
  isOpen: boolean;
}

export async function recordFailure(
  source: string,
  failureType: FailureType,
  config: BreakerConfig = DEFAULT_CONFIG,
): Promise<BreakerState> {
  const redis = getRedisConnection();
  const key = `${BREAKER_PREFIX}${source}`;

  const failures = await redis.hincrby(key, "consecutiveFailures", 1);
  const now = new Date().toISOString();
  await redis.hset(key, "lastFailureAt", now, "lastFailureType", failureType);

  if (failures >= config.maxFailures) {
    const cooldownUntil = new Date(Date.now() + config.cooldownMs).toISOString();
    await redis.hset(key, "cooldownUntil", cooldownUntil, "isOpen", "true");
    log.warn({ source, failures, cooldownUntil, failureType }, "Circuit breaker OPEN — entering cooldown");

    await updateDbCooldown(source, cooldownUntil, `${failureType} x${failures}`);

    return { source, consecutiveFailures: failures, lastFailureAt: now, cooldownUntil, isOpen: true };
  }

  return { source, consecutiveFailures: failures, lastFailureAt: now, cooldownUntil: null, isOpen: false };
}

export async function recordSuccess(source: string): Promise<void> {
  const redis = getRedisConnection();
  const key = `${BREAKER_PREFIX}${source}`;
  await redis.del(key);
}

export async function getBreakerState(source: string): Promise<BreakerState> {
  const redis = getRedisConnection();
  const key = `${BREAKER_PREFIX}${source}`;
  const data = await redis.hgetall(key);

  if (!data || Object.keys(data).length === 0) {
    return { source, consecutiveFailures: 0, lastFailureAt: null, cooldownUntil: null, isOpen: false };
  }

  const cooldownUntil = data.cooldownUntil ?? null;
  const isOpen = data.isOpen === "true" && cooldownUntil !== null && new Date(cooldownUntil) > new Date();

  if (data.isOpen === "true" && cooldownUntil !== null && new Date(cooldownUntil) <= new Date()) {
    await redis.del(key);
    log.info({ source }, "Circuit breaker cooldown expired — resetting");
    return { source, consecutiveFailures: 0, lastFailureAt: null, cooldownUntil: null, isOpen: false };
  }

  return {
    source,
    consecutiveFailures: parseInt(data.consecutiveFailures ?? "0", 10),
    lastFailureAt: data.lastFailureAt ?? null,
    cooldownUntil,
    isOpen,
  };
}

export async function isSourceInCooldown(source: string): Promise<boolean> {
  const state = await getBreakerState(source);
  return state.isOpen;
}

export async function forceResetBreaker(source: string): Promise<void> {
  const redis = getRedisConnection();
  await redis.del(`${BREAKER_PREFIX}${source}`);
  log.info({ source }, "Circuit breaker force-reset");
}

async function updateDbCooldown(source: string, cooldownUntil: string, reason: string): Promise<void> {
  try {
    const { query } = await import("../db/client.js");
    await query(
      `UPDATE public.source_schedule_state
       SET cooldown_until = $1, cooldown_reason = $2, updated_at = NOW()
       WHERE source = $3`,
      [cooldownUntil, reason, source],
    );
  } catch {
    log.warn({ source }, "Failed to update DB cooldown state (table may not exist yet)");
  }
}
