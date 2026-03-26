import "dotenv/config";
import { createChildLogger } from "../src/lib/logger.js";
import {
  fetchJoobleJobs,
  resolveJoobleLinkWithCamoufox,
} from "../src/sources/jooble-browser.js";
import { getBrowserProxyConfig } from "../src/lib/webshare.js";

const log = createChildLogger({ module: "probe-jooble-camoufox" });

async function main(): Promise<void> {
  const keywords = process.argv[2] ?? "software engineer";
  const location = process.argv[3] ?? "London";

  const proxy = await getBrowserProxyConfig();
  console.log("Proxy:", proxy ? proxy.server : "none");

  const jobs = await fetchJoobleJobs(keywords, location);
  console.log(`Jooble jobs returned: ${jobs.length}`);

  const first = jobs.find((job) => typeof job.link === "string" && job.link.length > 0);
  if (!first?.link) {
    throw new Error("No Jooble link returned by API");
  }

  console.log("Testing link:", first.link);
  const result = await resolveJoobleLinkWithCamoufox(first.link);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  log.error({ err }, "Jooble Camoufox probe failed");
  process.exitCode = 1;
});
