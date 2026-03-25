import { createHash } from "node:crypto";

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepWithJitter(baseMs: number, jitterPercent = 0.5): Promise<void> {
  const jitter = baseMs * jitterPercent * (Math.random() * 2 - 1);
  return sleep(Math.max(0, baseMs + jitter));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, label = "operation" } = opts;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        await sleepWithJitter(delay);
      }
    }
  }

  throw lastError ?? new Error(`${label} failed after ${maxRetries} retries`);
}
