import { getRedisConnection } from "../lib/redis.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger({ module: "source-lease" });

const LEASE_PREFIX = "lease:";
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

export interface LeaseInfo {
  source: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

export async function acquireLease(
  source: string,
  holder: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): Promise<LeaseInfo | null> {
  const redis = getRedisConnection();
  const key = `${LEASE_PREFIX}${source}`;
  const now = Date.now();
  const expiresAt = now + ttlMs;

  const existing = await redis.get(key);
  if (existing) {
    const parsed = JSON.parse(existing) as LeaseInfo;
    if (new Date(parsed.expiresAt).getTime() > now) {
      if (parsed.holder === holder) return parsed;
      log.debug({ source, currentHolder: parsed.holder, requestedBy: holder }, "Lease already held");
      return null;
    }
  }

  const lease: LeaseInfo = {
    source,
    holder,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };

  await redis.set(key, JSON.stringify(lease), "PX", ttlMs);
  log.info({ source, holder, ttlMs }, "Lease acquired");

  try {
    const { query } = await import("../db/client.js");
    await query(
      `UPDATE public.source_schedule_state
       SET lease_holder = $1, lease_acquired_at = $2, lease_expires_at = $3, updated_at = NOW()
       WHERE source = $4`,
      [holder, lease.acquiredAt, lease.expiresAt, source],
    );
  } catch { /* table may not exist */ }

  return lease;
}

export async function releaseLease(source: string, holder: string): Promise<boolean> {
  const redis = getRedisConnection();
  const key = `${LEASE_PREFIX}${source}`;

  const existing = await redis.get(key);
  if (!existing) return true;

  const parsed = JSON.parse(existing) as LeaseInfo;
  if (parsed.holder !== holder) {
    log.warn({ source, holder, actualHolder: parsed.holder }, "Cannot release — not the lease holder");
    return false;
  }

  await redis.del(key);
  log.info({ source, holder }, "Lease released");

  try {
    const { query } = await import("../db/client.js");
    await query(
      `UPDATE public.source_schedule_state
       SET lease_holder = NULL, lease_acquired_at = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE source = $1`,
      [source],
    );
  } catch { /* ok */ }

  return true;
}

export async function isLeaseHeld(source: string): Promise<LeaseInfo | null> {
  const redis = getRedisConnection();
  const key = `${LEASE_PREFIX}${source}`;

  const existing = await redis.get(key);
  if (!existing) return null;

  const parsed = JSON.parse(existing) as LeaseInfo;
  if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
    await redis.del(key);
    return null;
  }

  return parsed;
}

export async function extendLease(source: string, holder: string, ttlMs: number = DEFAULT_LEASE_TTL_MS): Promise<boolean> {
  const redis = getRedisConnection();
  const key = `${LEASE_PREFIX}${source}`;

  const existing = await redis.get(key);
  if (!existing) return false;

  const parsed = JSON.parse(existing) as LeaseInfo;
  if (parsed.holder !== holder) return false;

  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  parsed.expiresAt = expiresAt;
  await redis.set(key, JSON.stringify(parsed), "PX", ttlMs);
  return true;
}
