import { firefox } from "playwright";
import { createChildLogger } from "../lib/logger.js";
import { getBrowserProxyConfig } from "../lib/webshare.js";
import { getConfig } from "../shared/config.js";

const log = createChildLogger({ module: "stealth-browser" });

export async function fetchStealthHtml(url: string, platform: string): Promise<string> {
  const config = getConfig();
  
  if (!config.camoufoxPath) {
    log.warn("Camoufox path not configured, falling back to basic parsing");
    throw new Error("Missing CAMOUFOX_PATH");
  }

  const proxyConfig = await getBrowserProxyConfig();
  if (proxyConfig) {
    log.debug({ proxy: true, server: proxyConfig.server }, "Injecting proxy into Stealth Browser context");
  }

  log.info({ url, platform }, `Booting Stealth Browser (Camoufox) to bypass ${platform} defenses`);

  const browser = await firefox.launch({
    executablePath: config.camoufoxPath,
    headless: config.browserHeadless,
    proxy: proxyConfig ?? undefined,
    // Add additional firefox args for maximum stealth against Akamai/Incapsula
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-remote",
      "--new-instance",
    ]
  });

  try {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0"
    });
    
    // Add realistic randomized delays via addInitScript to evade simple timing attacks
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    
    // Determine wait strategy based on ATS platform
    const waitUntilStr = platform === "workday" || platform === "successfactors" ? "networkidle" : "domcontentloaded";
    
    await page.goto(url, { waitUntil: waitUntilStr, timeout: 25000 });
    
    // Inject intelligent wait for content to dynamically render (Workday specifics)
    if (platform === "workday") {
        try {
            // MyWorkdayJobs heavily relies on late JSON hydration
            await page.waitForSelector('[data-automation-id="jobPostingDescription"]', { timeout: 10000 });
        } catch {
            log.warn("Failed to find Workday descriptor, pulling current view anyways");
        }
    } else if (platform === "icims") {
        try {
            await page.waitForSelector('.iCIMS_JobContent', { timeout: 10000 });
        } catch {}
    } else if (platform === "successfactors") {
        try {
            await page.waitForSelector('.jobdescription, .job-description', { timeout: 10000 });
        } catch {}
    } else if (platform === "taleo") {
        try {
            await page.waitForSelector('.mastercontentpanel, .editablesection', { timeout: 10000 });
        } catch {}
    }

    const html = await page.content();
    log.info({ platform, bytes: html.length }, "Stealth browser successfully captured DOM");
    return html;
  } finally {
    await browser.close();
  }
}
