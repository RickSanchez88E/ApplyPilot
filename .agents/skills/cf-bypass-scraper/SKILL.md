---
name: cf-bypass-scraper
description: Bypass Cloudflare Turnstile/JS Challenge protection using headless Chrome CDP with separate profile isolation. Scrape CF-protected pages without interfering with user's browser.
---

# CF Bypass Scraper Skill

## When to Use
- Scraping websites protected by Cloudflare Turnstile or JS Challenge
- Any site returning "Just a moment..." or 403 to automated requests
- When `curl`, `fetch()`, `requests`, or Playwright (stealth) all get blocked
- When `curl_cffi` cookie injection fails due to JA3 fingerprint binding

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Background Headless Chrome (separate --user-data-dir)  │
│  Port 9333 | No UI | Doesn't touch user's Chrome     │
│  Cookies auto-renew | Session is effectively permanent  │
├─────────────────────────────────────────────────────┤
│  CDP Pool (cdp-pool.ts)                               │
│  - launchPersistentContext() with chrome channel       │
│  - navigator.webdriver = undefined                     │
│  - Auto-restart on crash                               │
├─────────────────────────────────────────────────────┤
│  navigateWithCf(url) → { page, html, blocked }        │
│  - CF auto-passes for real Chrome process              │
│  - 15s retry if challenge detected                     │
│  - Returns DOM for structured extraction               │
└─────────────────────────────────────────────────────┘
```

## Why This Works

| Approach | Result | Why |
|----------|--------|-----|
| `curl` / `fetch()` | ❌ 403 | No JS execution, no cookies |
| `curl_cffi` + Chrome TLS | ❌ 403 | JA3 hash doesn't exactly match |
| Playwright + Stealth | ❌ "Just a moment..." | CDP protocol detection |
| **Headless Chrome + CDP** | ✅ 200 | Real Chrome process, real JS, real TLS |

CF's `cf_clearance` cookie is bound to:
1. TLS fingerprint (JA3 hash) 
2. IP address
3. User-Agent string

By using Chrome's own process (not Playwright's modified Chromium), we get the **exact same JA3** as a real user. The persistent `--user-data-dir` keeps cookies alive across requests.

## Key Implementation Details

### 1. Separate Chrome Profile (CRITICAL)
```typescript
const CDP_PROFILE_DIR = path.join(os.tmpdir(), "cdp-scraper-profile");
```
This ensures the scraper Chrome **never touches** the user's real Chrome data. They can use Chrome normally while the scraper runs in background.

### 2. Anti-Detection
```typescript
args: [
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  "--no-first-run",
],
ignoreDefaultArgs: ["--enable-automation"],
```
Plus patching `navigator.webdriver`:
```typescript
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
```

### 3. Persistent Context
Use `chromium.launchPersistentContext()` instead of `chromium.launch()`. This keeps cookies across page navigations — one CF pass covers subsequent requests.

### 4. CF Challenge Handling
```typescript
if (blocked) {
  await page.waitForTimeout(15_000); // Wait for auto-resolve
  // Re-check title
}
```
Some CF challenges auto-resolve after JS execution. The 15s wait handles this.

## Lifecycle & Cookie Expiry

| Item | TTL | Impact |
|------|-----|--------|
| `cf_clearance` | 30min – 2h | Auto-renews on each page load |
| `__cf_bm` | ~30min | Session cookie, auto-issued |
| Chrome instance | Permanent | Stays alive until explicitly killed |
| `--user-data-dir` | Permanent | Persists on disk in tmp dir |

**As long as the Chrome instance keeps navigating pages periodically, the session is effectively permanent.** If Chrome crashes, `getCdpContext()` auto-relaunches.

## Usage in Code

### TypeScript/Node.js
```typescript
import { navigateWithCf, closeCdpPool } from "./lib/cdp-pool.js";

// Scrape a CF-protected page
const { page, html, blocked } = await navigateWithCf("https://example.com/protected-page", {
  referer: "https://example.com/",
  timeoutMs: 25_000,
});

if (!blocked) {
  // Extract data from the real DOM
  const data = await page.evaluate(`(() => {
    return {
      title: document.querySelector("h1")?.textContent || "",
      content: document.body.innerText.slice(0, 5000),
    };
  })()`);
  console.log(data);
}

await page.close();

// When done with all scraping
await closeCdpPool();
```

### Integration Pattern (Source Adapter)
```typescript
export async function scrapeProtectedSite(url: string): Promise<JobDetail | null> {
  const { page, html, blocked } = await navigateWithCf(url);
  try {
    if (blocked) return null;
    // ... extract data from page ...
    return data;
  } finally {
    await page.close();
  }
}
```

## What Was Tested & Failed

For reference, these approaches were tested against Jooble (Cloudflare Managed Challenge):

1. ❌ `playwright-extra` + `puppeteer-extra-plugin-stealth` — `webdriver=false` ✅ but CF still detected CDP protocol
2. ❌ `curl_cffi` with `chrome142` impersonation — JA3 mismatch even with real `cf_clearance` cookie
3. ❌ `browser-cookie3` → `curl_cffi` — Chrome 146 JA3 not matched by any `curl_cffi` target  
4. ❌ Cookie injection into `fetch()` — Node.js TLS stack JA3 is completely different from Chrome
5. ✅ **CDP with `launchPersistentContext()` + `channel: "chrome"`** — bypasses all checks

## Prerequisites

- **Google Chrome** installed at standard location
- **Playwright** npm package (`npm install playwright`)
- Ports 9222 (optional debug) and 9333 (CDP pool) available

## Jooble: many `/desc/` URLs (apply link extraction)

Opening **one new tab per URL** causes many parallel CF challenges and rate limits. Prefer:

1. **`withCdpTab()`** (`src/lib/cdp-pool.ts`) — acquires **one** pool slot and **one** `Page`.
2. **`navigateExistingPage(page, url)`** — `goto` + same CF wait logic as `navigateWithCf`, **without** a new tab.
3. **`scrapeJoobleDescOnPage(page, descUrl)`** (`src/sources/jooble-browser.ts`) — parse employer apply URL from the loaded DOM.

Live scrape (`scrapeJoobleForKeyword`) and CLI backfill (`scripts/backfill-jooble-apply-urls.ts`) use this **single-tab sequential** pattern so `cf_clearance` stays warm and concurrency stays at **one** tab for the whole batch.

## Files

- `src/lib/cdp-pool.ts` — CDP browser pool manager (`navigateWithCf`, `navigateExistingPage`, `withCdpTab`)
- `src/sources/jooble-browser.ts` — Jooble integration (`scrapeJoobleDescOnPage`, `scrapeJoobleDesc`)
- `src/sources/jooble.ts` — Source adapter using CDP pool
- `scripts/backfill-jooble-apply-urls.ts` — DB backfill using `withCdpTab` + `scrapeJoobleDescOnPage`
