import { describe, expect, it } from "vitest";
import { parseJobDetailHtml, parseSearchResultsHtml } from "../ingest/job-parser.js";

describe("job-parser apply url extraction", () => {
  it("parses search result cards and normalizes LinkedIn URLs", () => {
    const html = `
      <html>
        <body>
          <ul>
            <li class="jobs-search-results__list-item">
              <a class="base-card__full-link" href="/jobs/view/senior-security-engineer-1234567890?trackingId=abc"></a>
              <h3 class="base-search-card__title">Senior Security Engineer</h3>
              <h4 class="base-search-card__subtitle"><a>Acme</a></h4>
              <span class="job-search-card__location">London, United Kingdom</span>
              <span class="job-search-card__salary-info">£90,000</span>
              <time datetime="2026-03-20T00:00:00.000Z"></time>
            </li>
          </ul>
        </body>
      </html>
    `;

    const results = parseSearchResultsHtml(html);

    expect(results).toHaveLength(1);
    expect(results[0]?.linkedinUrl).toBe("https://www.linkedin.com/jobs/view/1234567890/");
    expect(results[0]?.jobTitle).toBe("Senior Security Engineer");
    expect(results[0]?.companyName).toBe("Acme");
    expect(results[0]?.salaryText).toBe("£90,000");
  });

  it("keeps easy apply jobs as easy_apply when no external link is present", () => {
    const html = `
      <html>
        <body>
          <div class="description__text">${"Build backend systems for payments. ".repeat(6)}</div>
          <button class="jobs-apply-button">Easy Apply</button>
        </body>
      </html>
    `;

    const detail = parseJobDetailHtml(html);

    expect(detail.applyType).toBe("easy_apply");
    expect(detail.applyUrl).toBeNull();
    expect(detail.atsPlatform).toBeNull();
  });

  it("extracts a direct external apply link", () => {
    const html = `
      <html>
        <body>
          <div class="description__text">Build backend systems for payments.</div>
          <a class="jobs-apply-button" href="https://jobs.example.com/apply/123">Apply</a>
        </body>
      </html>
    `;

    const detail = parseJobDetailHtml(html);

    expect(detail.applyType).toBe("external");
    expect(detail.applyUrl).toBe("https://jobs.example.com/apply/123");
    expect(detail.atsPlatform).toBe("generic");
  });

  it("unwraps LinkedIn redirect links to the external target", () => {
    const html = `
      <html>
        <body>
          <div class="description__text">Security engineering role.</div>
          <a
            data-tracking-control-name="public_jobs_apply-link-offsite"
            href="https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F42"
          >
            Apply externally
          </a>
        </body>
      </html>
    `;

    const detail = parseJobDetailHtml(html);

    expect(detail.applyUrl).toBe("https://boards.greenhouse.io/acme/jobs/42");
    expect(detail.atsPlatform).toBe("greenhouse");
  });

  it("prefers an external apply link even if the page mentions easy apply elsewhere", () => {
    const html = `
      <html>
        <body>
          <div class="description__text">${"This role offers a streamlined easy apply experience on LinkedIn, but can also be completed externally. ".repeat(4)}</div>
          <a
            data-tracking-control-name="public_jobs_apply-link-offsite"
            href="https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Facme.myworkdayjobs.com%2Fen-US%2Fcareers%2Fjob%2FLondon%2F123"
          >
            Apply externally
          </a>
        </body>
      </html>
    `;

    const detail = parseJobDetailHtml(html);

    expect(detail.applyType).toBe("external");
    expect(detail.applyUrl).toBe("https://acme.myworkdayjobs.com/en-US/careers/job/London/123");
    expect(detail.atsPlatform).toBe("workday");
  });

  it("rejects LinkedIn job pages when extracting external apply urls", () => {
    const html = `
      <html>
        <body>
          <div class="description__text">Backend platform role.</div>
          <a
            data-tracking-control-name="public_jobs_topcard-orig-link"
            href="https://uk.linkedin.com/jobs/view/backend-platform-engineer-1234567890?trk=public_jobs_topcard-title"
          >
            View job
          </a>
        </body>
      </html>
    `;

    const detail = parseJobDetailHtml(html);

    expect(detail.applyType).toBe("external");
    expect(detail.applyUrl).toBeNull();
    expect(detail.atsPlatform).toBeNull();
  });

  it("extracts escaped apply urls embedded in page JSON", () => {
    const html = `
      <html>
        <body>
          <div class="description__text">Distributed systems work.</div>
          <script type="application/json">
            {"companyApplyUrl":"https:\\u002F\\u002Facme.myworkdayjobs.com\\u002Fen-US\\u002Fcareers\\u002Fjob\\u002FLondon\\u002F123"}
          </script>
        </body>
      </html>
    `;

    const detail = parseJobDetailHtml(html);

    expect(detail.applyUrl).toBe("https://acme.myworkdayjobs.com/en-US/careers/job/London/123");
    expect(detail.atsPlatform).toBe("workday");
  });
});
