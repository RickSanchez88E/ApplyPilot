/**
 * Queue setup — creates BullMQ queues and provides dispatch helper.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "../lib/redis.js";
import { QUEUE_NAMES, routeCommand, type CommandPayload, type QueueName } from "./commands.js";

const queues = new Map<QueueName, Queue>();

function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: getRedisConnection() });
    queues.set(name, q);
  }
  return q;
}

export async function dispatch(payload: CommandPayload): Promise<string> {
  const queueName = routeCommand(payload);
  const q = getQueue(queueName);
  const job = await q.add(payload.type, payload, {
    attempts: payload.type === "discover_jobs" ? 2 : 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  });
  return job.id ?? "unknown";
}

export async function closeQueues(): Promise<void> {
  for (const q of queues.values()) {
    await q.close();
  }
  queues.clear();
}

export { getQueue, QUEUE_NAMES };
