import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCookieHeader,
  checkSessionHealth,
  isSessionExpiredResponse,
  type SessionState,
} from "../session-manager.js";

const baseSession: SessionState = {
  liAt: "cookie-value",
  jsessionId: "ajax:123",
  lastCheckedAt: null,
  healthy: false,
};

describe("session-manager", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("builds the LinkedIn cookie header", () => {
    expect(buildCookieHeader(baseSession)).toBe('li_at=cookie-value; JSESSIONID="ajax:123"');
  });

  it("marks a session unhealthy on 403 responses", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("", {
        status: 403,
        headers: new Headers(),
      }),
    );

    const result = await checkSessionHealth(baseSession);

    expect(result.healthy).toBe(false);
    expect(result.lastCheckedAt).toBeInstanceOf(Date);
  });

  it("marks a session unhealthy when LinkedIn redirects to login", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("", {
        status: 302,
        headers: new Headers({ location: "https://www.linkedin.com/login" }),
      }),
    );

    const result = await checkSessionHealth(baseSession);

    expect(result.healthy).toBe(false);
  });

  it("marks a session unhealthy on network errors", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("socket hang up"));

    const result = await checkSessionHealth(baseSession);

    expect(result.healthy).toBe(false);
  });

  it("marks a session healthy on a normal response", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("<html></html>", {
        status: 200,
        headers: new Headers(),
      }),
    );

    const result = await checkSessionHealth(baseSession);

    expect(result.healthy).toBe(true);
    expect(result.lastCheckedAt).toBeInstanceOf(Date);
  });

  it("treats authwall redirects as expired sessions", () => {
    expect(
      isSessionExpiredResponse(
        302,
        new Headers({ location: "https://www.linkedin.com/authwall?trk=public_jobs" }),
      ),
    ).toBe(true);
  });
});
