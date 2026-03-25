import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionExpiredError } from "../errors.js";

const getExistingHashesMock = vi.fn();
const sleepWithJitterMock = vi.fn().mockResolvedValue(undefined);
const withRetryMock = vi.fn(async (fn: () => Promise<string>) => await fn());

vi.mock("../dedup.js", () => ({
  getExistingHashes: getExistingHashesMock,
}));

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleepWithJitter: sleepWithJitterMock,
    withRetry: withRetryMock,
  };
});

const baseSession = {
  liAt: "li_at",
  jsessionId: "ajax:123",
  lastCheckedAt: new Date(),
  healthy: true,
} as const;

describe("linkedin-scraper", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    getExistingHashesMock.mockReset();
    sleepWithJitterMock.mockClear();
    withRetryMock.mockClear();
    global.fetch = originalFetch;
  });

  it("continues when a detail page fails and returns partial success", async () => {
    getExistingHashesMock.mockResolvedValue(new Set());
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          `
          <ul>
            <li class="jobs-search-results__list-item">
              <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/1234567890/"></a>
              <h3 class="base-search-card__title">Security Engineer</h3>
              <h4 class="base-search-card__subtitle"><a>Acme</a></h4>
              <span class="job-search-card__location">London, United Kingdom</span>
              <time datetime="2026-03-20T00:00:00.000Z"></time>
            </li>
            <li class="jobs-search-results__list-item">
              <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/9876543210/"></a>
              <h3 class="base-search-card__title">Platform Engineer</h3>
              <h4 class="base-search-card__subtitle"><a>Globex</a></h4>
              <span class="job-search-card__location">London, United Kingdom</span>
              <time datetime="2026-03-20T00:00:00.000Z"></time>
            </li>
          </ul>`,
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `
          <html>
            <body>
              <div class="description__text">${"Secure systems and APIs. ".repeat(8)}</div>
              <a class="jobs-apply-button" href="https://jobs.acme.com/apply/1">Apply</a>
            </body>
          </html>`,
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 500 }));

    const { scrapeJobs } = await import("../linkedin-scraper.js");
    const result = await scrapeJobs(baseSession, "security engineer", "London", "r86400");

    expect(result.pagesScraped).toBe(1);
    expect(result.totalParsed).toBe(2);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.companyName).toBe("Acme");
  });

  it("stops pagination when a search page fetch fails", async () => {
    getExistingHashesMock.mockResolvedValue(new Set());
    global.fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 500 }));

    const { scrapeJobs } = await import("../linkedin-scraper.js");
    const result = await scrapeJobs(baseSession, "security engineer", "London", "r86400");

    expect(result).toEqual({
      jobs: [],
      pagesScraped: 0,
      totalParsed: 0,
      skippedExisting: 0,
    });
  });

  it("throws when the session expires mid-scrape", async () => {
    getExistingHashesMock.mockResolvedValue(new Set());
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          `
          <ul>
            <li class="jobs-search-results__list-item">
              <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/1234567890/"></a>
              <h3 class="base-search-card__title">Security Engineer</h3>
              <h4 class="base-search-card__subtitle"><a>Acme</a></h4>
              <span class="job-search-card__location">London, United Kingdom</span>
            </li>
          </ul>`,
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 403 }));

    const { scrapeJobs } = await import("../linkedin-scraper.js");

    await expect(
      scrapeJobs(baseSession, "security engineer", "London", "r86400"),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
