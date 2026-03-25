import { getConfig } from "./config.js";
import { SessionExpiredError } from "./errors.js";
import { createChildLogger } from "./logger.js";

const log = createChildLogger({ module: "session" });

export interface SessionState {
  readonly liAt: string;
  readonly jsessionId: string;
  readonly lastCheckedAt: Date | null;
  readonly healthy: boolean;
}

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const SESSION_CHECK_TIMEOUT_MS = 10_000;

export function createSession(): SessionState {
  const config = getConfig();

  if (!config.linkedinLiAt) {
    log.warn("LINKEDIN_LI_AT is empty — session will fail on first request");
  }

  return {
    liAt: config.linkedinLiAt,
    jsessionId: config.linkedinJsessionId,
    lastCheckedAt: null,
    healthy: false,
  };
}

export function buildCookieHeader(session: SessionState): string {
  const parts: string[] = [];

  if (session.liAt) {
    parts.push(`li_at=${session.liAt}`);
  }
  if (session.jsessionId) {
    parts.push(`JSESSIONID="${session.jsessionId}"`);
  }

  return parts.join("; ");
}

export function buildLinkedInHeaders(
  session: SessionState,
  userAgent: string,
): Record<string, string> {
  return {
    Cookie: buildCookieHeader(session),
    "User-Agent": userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "csrf-token": session.jsessionId,
  };
}

export async function checkSessionHealth(session: SessionState): Promise<SessionState> {
  log.info("Checking LinkedIn session health...");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SESSION_CHECK_TIMEOUT_MS);

    const response = await fetch(LINKEDIN_FEED_URL, {
      method: "GET",
      headers: {
        Cookie: buildCookieHeader(session),
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "manual",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const isExpired = isSessionExpiredResponse(response.status, response.headers);

    if (isExpired) {
      log.warn(
        { status: response.status },
        "LinkedIn session expired or invalid — refresh cookies",
      );
      return {
        ...session,
        lastCheckedAt: new Date(),
        healthy: false,
      };
    }

    log.info({ status: response.status }, "LinkedIn session is healthy");
    return {
      ...session,
      lastCheckedAt: new Date(),
      healthy: true,
    };
  } catch (err) {
    log.error({ err }, "Failed to check session health");
    return {
      ...session,
      lastCheckedAt: new Date(),
      healthy: false,
    };
  }
}

export function isSessionExpiredResponse(status: number, headers?: Headers): boolean {
  if (status === 401 || status === 403) {
    return true;
  }

  if (status >= 300 && status < 400) {
    const location = headers?.get("location") ?? "";
    if (
      location.includes("/login") ||
      location.includes("/authwall") ||
      location.includes("/uas/login")
    ) {
      return true;
    }
  }

  return false;
}

export function assertSessionValid(session: SessionState): void {
  if (!session.liAt) {
    throw new SessionExpiredError();
  }

  if (session.lastCheckedAt !== null && !session.healthy) {
    throw new SessionExpiredError();
  }
}
