import "dotenv/config";
import { joobleAdapter } from "../src/sources/jooble.js";

async function main(): Promise<void> {
  const jobs = await joobleAdapter.fetchJobs(["software engineer"], "London");
  console.log(
    JSON.stringify(
      {
        count: jobs.length,
        preview: jobs.slice(0, 3).map((job) => ({
          title: job.jobTitle,
          company: job.companyName,
          applyUrl: job.applyUrl,
          sourceUrl: job.sourceUrl,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
