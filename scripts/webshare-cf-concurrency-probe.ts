/**
 * Step through increasing **parallel** Playwright contexts (each bound to a Webshare proxy,
 * round-robin if fewer proxies than concurrency). Measures when Jooble returns CF-style title/body.
 *
 * Env:
 *   WEBSHARE_API_KEY — required
 *   CF_PROBE_LEVELS — comma list, default "1,2,4,6,8,10,12"
 *   CF_PROBE_URL — target (default Jooble search)
 *   CF_PROBE_COOLDOWN_MS — pause between levels (default 4000)
 *   CF_PROBE_MINIMAL_BANDWIDTH — if not "0": block img/css/font/media and skip page.content() (default: on)
 */
import "dotenv/config";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { getConfig } from "../src/shared/config.js";
import { listWebshareBrowserProxies } from "../src/lib/webshare.js";
import { attachMinimalBandwidthRoutes } from "../src/sources/jooble-browser.js";
import { createChildLogger } from "../src/lib/logger.js";

const log = createChildLogger({ module: "webshare-cf-probe" });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function isCfTitle(title: string): boolean {
  return /just a moment|checking your browser|performing security|attention required|cf-browser-verification/i.test(
    title,
  );
}

function isCfBodySnippet(htmlHead: string): boolean {
  const s = htmlHead.slice(0, 8000).toLowerCase();
  return (
    s.includes("just a moment") ||
    s.includes("checking your browser") ||
    s.includes("cf-browser-verification") ||
    s.includes("challenge-platform") ||
    s.includes("turnstile")
  );
}

function parseLevels(): number[] {
  const raw = process.env.CF_PROBE_LEVELS ?? "1,2,4,6,8,10,12";
  return raw
    .split(",")
    .map((x) => Number.parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)]!;
}

async function createProxyContext(
  browser: Browser,
  proxy: { server: string; username?: string; password?: string },
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
    viewport: { width: 1366, height: 900 },
    userAgent: UA,
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return ctx;
}

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.webshareApiKey) {
    console.error("WEBSHARE_API_KEY required");
    process.exit(1);
  }

  const targetUrl =
    process.env.CF_PROBE_URL ??
    "https://jooble.org/SearchResult?rgns=United%20Kingdom&ukw=software+engineer&p=1";
  const cooldown = Number.parseInt(process.env.CF_PROBE_COOLDOWN_MS ?? "4000", 10) || 4000;
  const probeMinimalBandwidth = process.env.CF_PROBE_MINIMAL_BANDWIDTH !== "0";
  const levels = parseLevels();
  const maxLevel = Math.max(...levels);

  const proxies = await listWebshareBrowserProxies(Math.max(maxLevel, 16));
  if (proxies.length === 0) {
    console.error("No Webshare proxies returned");
    process.exit(1);
  }

  log.info(
    {
      levels,
      maxLevel,
      proxyCount: proxies.length,
      targetUrl: targetUrl.slice(0, 100),
      probeMinimalBandwidth,
    },
    "CF concurrency probe (Webshare-only contexts)",
  );

  const browser = await chromium.launch({
    headless: config.browserHeadless,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  });

  const summary: {
    level: number;
    ok: number;
    cfTitle: number;
    cfBodyOnly: number;
    tunnelFail: number;
    otherFail: number;
    msP50: number;
    msMax: number;
  }[] = [];

  try {
    for (const level of levels) {
      const contexts: BrowserContext[] = [];

      for (let i = 0; i < level; i++) {
        const p = proxies[i % proxies.length]!;
        contexts.push(await createProxyContext(browser, p));
      }

      let cfTitle = 0;
      let cfBodyOnly = 0;
      let tunnelFail = 0;
      let otherFail = 0;
      let ok = 0;

      const results = await Promise.all(
        contexts.map(async (ctx) => {
          const page = await ctx.newPage();
          if (probeMinimalBandwidth) {
            await attachMinimalBandwidthRoutes(page);
          }
          const start = Date.now();
          try {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
            await page.waitForTimeout(1200);
            const title = await page.title();
            const htmlHead = probeMinimalBandwidth ? "" : (await page.content()).slice(0, 8000);
            const ms = Date.now() - start;
            return { title, htmlHead, ms, err: null as string | null };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { title: "", htmlHead: "", ms: Date.now() - start, err: msg };
          } finally {
            await page.close();
          }
        }),
      );

      for (const r of results) {
        if (r.err) {
          if (/ERR_TUNNEL|ERR_PROXY|TIMED_OUT|ETIMEDOUT/i.test(r.err)) tunnelFail++;
          else otherFail++;
          continue;
        }
        const tCf = isCfTitle(r.title);
        const bCf = isCfBodySnippet(r.htmlHead);
        if (tCf) {
          cfTitle++;
          continue;
        }
        if (bCf && !tCf) {
          cfBodyOnly++;
          continue;
        }
        ok++;
      }

      const times = results.filter((r) => !r.err).map((r) => r.ms);
      times.sort((a, b) => a - b);

      summary.push({
        level,
        ok,
        cfTitle,
        cfBodyOnly,
        tunnelFail,
        otherFail,
        msP50: percentile(times, 50),
        msMax: times.length ? times[times.length - 1]! : 0,
      });

      log.info(
        {
          level,
          ok,
          cfTitle,
          cfBodyOnly,
          tunnelFail,
          otherFail,
        },
        "level complete",
      );

      for (const c of contexts) {
        await c.close().catch(() => {});
      }

      await new Promise((r) => setTimeout(r, cooldown));
    }
  } finally {
    await browser.close();
  }

  console.log("\n=== CF probe summary (Webshare parallel contexts) ===\n");
  console.log(JSON.stringify({ targetUrl, levels, results: summary }, null, 2));

  const firstCf = summary.find((s) => s.cfTitle > 0 || s.cfBodyOnly > 0);
  if (firstCf) {
    console.log(
      `\nFirst level with any CF signal: concurrent=${firstCf.level} (cfTitle=${firstCf.cfTitle}, cfBodyOnly=${firstCf.cfBodyOnly})`,
    );
  } else {
    console.log("\nNo CF title/body heuristics triggered in this run (tunnel errors may still occur).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
