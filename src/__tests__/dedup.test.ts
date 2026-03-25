import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewJob } from "../types.js";
import { hashUrl } from "../utils.js";

const queryMock = vi.fn();

vi.mock("../db/client.js", () => ({
  query: queryMock,
}));

describe("dedup", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("inserts only new jobs and counts duplicates as skipped", async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });

    const { dedupAndInsert } = await import("../dedup.js");

    const jobs: NewJob[] = [
      {
        linkedinUrl: "https://www.linkedin.com/jobs/view/123/",
        companyName: "Acme",
        jobTitle: "Security Engineer",
        jdRaw: "A".repeat(120),
        applyType: "external",
        applyUrl: "https://jobs.acme.com/apply/123",
        atsPlatform: "generic",
      },
      {
        linkedinUrl: "https://www.linkedin.com/jobs/view/123/?trk=public_jobs_topcard-title",
        companyName: "Acme",
        jobTitle: "Security Engineer",
        jdRaw: "A".repeat(120),
        applyType: "external",
        applyUrl: "https://jobs.acme.com/apply/123",
        atsPlatform: "generic",
      },
    ];

    const result = await dedupAndInsert(jobs);

    expect(result).toEqual({ inserted: 1, skipped: 1 });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("returns existing hashes for pre-filtering", async () => {
    const existingUrl = "https://www.linkedin.com/jobs/view/123/";
    queryMock.mockResolvedValue({
      rows: [{ url_hash: hashUrl(existingUrl) }],
    });

    const { getExistingHashes } = await import("../dedup.js");
    const result = await getExistingHashes([
      existingUrl,
      "https://www.linkedin.com/jobs/view/456/",
    ]);

    expect(result.has(hashUrl(existingUrl))).toBe(true);
    expect(result.has(hashUrl("https://www.linkedin.com/jobs/view/456/"))).toBe(false);
  });
});
