/**
 * Minimal-bandwidth Jooble /desc/ run: block img/css/font/media, do not call page.content(),
 * evaluate apply-link heuristics only. For Webshare and other bandwidth-metered proxies.
 *
 * Usage:
 *   npx tsx scripts/jooble-minimal-apply-url.ts "https://jooble.org/desc/...."
 */
import "dotenv/config";
import { chromium } from "playwright";
import { getConfig } from "../src/shared/config.js";
import {
  attachMinimalBandwidthRoutes,
  isExternalEmployerApplyUrl,
  scrapeJoobleDescOnPage,
} from "../src/sources/jooble-browser.js";
import { createChildLogger } from "../src/lib/logger.js";

const log = createChildLogger({ module: "jooble-minimal-apply" });

async function main(): Promise<void> {
  const url =
    process.argv.find((a) => a.includes("/desc/")) ??
    process.env.JOOBLE_MINIMAL_TEST_URL ??
    "";

  if (!url.startsWith("http")) {
    console.error('Pass one Jooble /desc/ URL as argv or set JOOBLE_MINIMAL_TEST_URL');
    process.exit(1);
  }

  const config = getConfig();
  const browser = await chromium.launch({
    headless: config.browserHeadless,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  });

  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await ctx.newPage();
  await attachMinimalBandwidthRoutes(page);

  try {
    const outcome = await scrapeJoobleDescOnPage(page, url, {
      minimalBandwidth: true,
      skipAttachRoutes: true,
    });

    if (!outcome.ok) {
      console.log(
        JSON.stringify(
          { ok: false, reason: outcome.reason, expired: outcome.expired, sourceUrl: url },
          null,
          2,
        ),
      );
    } else {
      const d = outcome.detail;
      const accepted = isExternalEmployerApplyUrl(d.applyUrl);
      console.log(
        JSON.stringify(
          {
            ok: true,
            sourceUrl: url,
            applyUrlRaw: d.applyUrl || null,
            applyUrlAccepted: accepted,
            title: d.title,
            note: "minimal: no full HTML to Node; img/css/font blocked; JD 未抓取",
          },
          null,
          2,
        ),
      );
      if (accepted && d.applyUrl) {
        console.log("\n--- 雇主申请链（已通过过滤，可自测）---\n");
        console.log(d.applyUrl);
      } else if (d.applyUrl) {
        console.log("\n(原始解析链接，可能被 isExternalEmployerApplyUrl 过滤)\n" + d.applyUrl);
      }
    }
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((e) => {
  log.error({ e }, "failed");
  console.error(e);
  process.exit(1);
});
