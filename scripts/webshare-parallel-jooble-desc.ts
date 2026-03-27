/**
 * Parallel Jooble (or any HTTP) smoke test: 1 local Chrome context + 3 Webshare proxy contexts,
 * 4 concurrent workers, 5 target URLs (round-robin contexts). Uses real Chrome + per-context proxy
 * (cf-bypass-scraper pattern) without touching the main CDP pool.
 *
 * Usage:
 *   npx tsx scripts/webshare-parallel-jooble-desc.ts --demo
 *   npx tsx scripts/webshare-parallel-jooble-desc.ts "https://..." "https://..." (5 URLs)
 *   JOOBLE_PARALLEL_URLS="url1,url2,url3,url4,url5" npx tsx scripts/webshare-parallel-jooble-desc.ts
 *
 * Env:
 *   WEBSHARE_API_KEY — required (unless --local-only for 1 worker test)
 *   WEBSHARE_PROXY_LIST_MODE — default backbone (residential-style pool in Webshare docs)
 */
import "dotenv/config";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { getConfig } from "../src/shared/config.js";
import { listWebshareBrowserProxies } from "../src/lib/webshare.js";
import { createChildLogger } from "../src/lib/logger.js";

const log = createChildLogger({ module: "webshare-parallel-probe" });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function createContext(
  browser: Browser,
  label: string,
  proxy: { server: string; username?: string; password?: string } | undefined,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    proxy,
    viewport: { width: 1366, height: 900 },
    userAgent: UA,
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  log.info({ label, proxy: proxy?.server ?? "direct" }, "Browser context ready");
  return ctx;
}

function parseUrls(): string[] {
  const fromEnv = process.env.JOOBLE_PARALLEL_URLS?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("http"));
  if (fromEnv && fromEnv.length >= 5) return fromEnv.slice(0, 5);

  const argv = process.argv.slice(2).filter((a) => a.startsWith("http"));
  if (argv.length >= 5) return argv.slice(0, 5);

  if (process.argv.includes("--demo")) {
    const one =
      process.env.JOOBLE_SINGLE_TEST_URL ??
      "https://jooble.org/SearchResult?rgns=United%20Kingdom&ukw=software+engineer&p=1";
    log.warn({ url: one.slice(0, 80) }, "--demo: using same URL 5x (concurrency test only)");
    return Array.from({ length: 5 }, () => one);
  }

  console.error(
    "Provide 5 URLs: argv, or JOOBLE_PARALLEL_URLS, or use --demo (same URL 5x). WEBSHARE_API_KEY required for 3 proxies.",
  );
  process.exit(1);
}

const CONCURRENCY = 4;

async function main(): Promise<void> {
  const urls = parseUrls();
  const localOnly = process.argv.includes("--local-only");
  const config = getConfig();

  let proxies: Awaited<ReturnType<typeof listWebshareBrowserProxies>> = [];
  if (!localOnly) {
    if (!config.webshareApiKey) {
      console.error("Set WEBSHARE_API_KEY or pass --local-only (single direct context, 5 sequential).");
      process.exit(1);
    }
    proxies = await listWebshareBrowserProxies(3);
    if (proxies.length < 3) {
      console.error(
        `Need 3 Webshare proxy endpoints; got ${proxies.length}. Check plan (residential often uses mode=backbone).`,
      );
      process.exit(1);
    }
  }

  const routes: { label: string; proxy?: { server: string; username?: string; password?: string } }[] = [
    { label: "local-direct" },
    ...proxies.slice(0, 3).map((p, i) => ({
      label: `webshare-${i + 1}`,
      proxy: { server: p.server, username: p.username, password: p.password },
    })),
  ];

  log.info(
    { workers: routes.length, concurrency: CONCURRENCY, urls: urls.length, modes: "1+3 proxy IPs" },
    "Starting parallel Chrome (single browser, multiple contexts)",
  );

  const browser = await chromium.launch({
    headless: config.browserHeadless,
    channel: "chrome",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-first-run",
    ],
  });

  const contexts: BrowserContext[] = [];
  try {
    for (const r of routes) {
      contexts.push(await createContext(browser, r.label, r.proxy));
    }

    const results: {
      index: number;
      url: string;
      label: string;
      title: string;
      blocked: boolean;
      htmlBytes: number;
      ms: number;
    }[] = [];

    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= urls.length) break;
        const url = urls[i]!;
        const ctx = contexts[i % contexts.length]!;
        const label = routes[i % routes.length]!.label;
        const t0 = Date.now();
        const page = await ctx.newPage();
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await page.waitForTimeout(1500);
          const title = await page.title();
          const html = await page.content();
          const blocked = /just a moment|checking your browser/i.test(title);
          results[i] = {
            index: i,
            url,
            label,
            title: title.slice(0, 120),
            blocked,
            htmlBytes: html.length,
            ms: Date.now() - t0,
          };
          log.info({ i, label, blocked, ms: results[i]!.ms }, "nav done");
        } catch (err) {
          results[i] = {
            index: i,
            url,
            label,
            title: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
            blocked: false,
            htmlBytes: 0,
            ms: Date.now() - t0,
          };
          log.error({ err, i, label }, "nav failed");
        } finally {
          await page.close();
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    results.sort((a, b) => a.index - b.index);
    console.log(JSON.stringify({ routes: routes.map((r) => r.label), results }, null, 2));
  } finally {
    for (const c of contexts) {
      await c.close().catch(() => {});
    }
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
