import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewJob } from "../shared/types.js";
import { hashUrl } from "../lib/utils.js";

const queryMock = vi.fn();

vi.mock("../db/client.js", () => ({
  query: queryMock,
}));

describe("dedup", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("inserts only new jobs and counts duplicates as skipped", async () => {
    // First call: check for cross-platform dupe (none found)
    queryMock.mockResolvedValueOnce({ rows: [] });
    // Second call: insert (success)
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    // Third call: check for cross-platform dupe (none found from different source)
    queryMock.mockResolvedValueOnce({ rows: [] });
    // Fourth call: insert (conflict — same url_hash)
    queryMock.mockResolvedValueOnce({ rowCount: 0 });

    const { dedupAndInsert } = await import("../ingest/dedup.js");

    const jobs: NewJob[] = [
      {
        linkedinUrl: "https://www.linkedin.com/jobs/view/123/",
        companyName: "Acme",
        jobTitle: "Security Engineer",
        jdRaw: "A".repeat(120),
        applyType: "external",
        applyUrl: "https://jobs.acme.com/apply/123",
        atsPlatform: "generic",
        source: "linkedin",
      },
      {
        linkedinUrl: "https://www.linkedin.com/jobs/view/123/?trk=public_jobs_topcard-title",
        companyName: "Acme",
        jobTitle: "Security Engineer",
        jdRaw: "A".repeat(120),
        applyType: "external",
        applyUrl: "https://jobs.acme.com/apply/123",
        atsPlatform: "generic",
        source: "linkedin",
      },
    ];

    const result = await dedupAndInsert(jobs);

    expect(result).toEqual({ inserted: 1, skipped: 1, crossPlatformDupes: 0 });
    expect(queryMock).toHaveBeenCalledTimes(4); // 2 x (content_hash check + insert)
  });

  it("returns existing hashes for pre-filtering", async () => {
    const existingUrl = "https://www.linkedin.com/jobs/view/123/";
    queryMock.mockResolvedValue({
      rows: [{ url_hash: hashUrl(existingUrl) }],
    });

    const { getExistingHashes } = await import("../ingest/dedup.js");
    const result = await getExistingHashes([
      existingUrl,
      "https://www.linkedin.com/jobs/view/456/",
    ]);

    expect(result.has(hashUrl(existingUrl))).toBe(true);
    expect(result.has(hashUrl("https://www.linkedin.com/jobs/view/456/"))).toBe(false);
  });
});
