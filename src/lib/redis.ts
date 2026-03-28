/**
 * Shared Redis connection for BullMQ queues and pub/sub.
 *
 * Connection params from REDIS_URL env var; defaults to localhost:6379.
 */

import { Redis } from "ioredis";

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (connection) return connection;
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  connection = new Redis(url, { maxRetriesPerRequest: null });
  return connection;
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
