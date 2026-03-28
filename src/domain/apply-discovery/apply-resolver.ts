import type { Page } from "playwright";
import { createChildLogger } from "../../lib/logger.js";
import type {
  ApplyResolutionResult,
  ApplyDiscoveryStatus,
  RedirectStep,
  FormSchemaSnapshot,
} from "./types.js";

const log = createChildLogger({ module: "apply-resolver" });

const LOGIN_PATTERNS = [
  /\/login/i, /\/signin/i, /\/sign-in/i, /\/auth/i,
  /accounts\.google\.com/i, /\/sso\//i, /\/saml/i,
];

const OAUTH_GOOGLE_PATTERNS = [
  /accounts\.google\.com\/o\/oauth2/i,
  /accounts\.google\.com\/signin/i,
  /accounts\.google\.com\/AccountChooser/i,
];

const OAUTH_LINKEDIN_PATTERNS = [
  /linkedin\.com\/oauth/i,
  /linkedin\.com\/uas\/login/i,
];

const REGISTRATION_PATTERNS = [
  /\/register/i, /\/signup/i, /\/sign-up/i, /\/create-account/i,
];

const ATS_PROVIDERS: Record<string, RegExp> = {
  greenhouse: /greenhouse\.io|boards\.greenhouse/i,
  lever: /lever\.co|jobs\.lever/i,
  workday: /workday\.com|myworkdayjobs/i,
  ashby: /ashbyhq\.com/i,
  bamboohr: /bamboohr\.com/i,
  icims: /icims\.com/i,
  smartrecruiters: /smartrecruiters\.com/i,
  taleo: /taleo\.net/i,
  successfactors: /successfactors\.com/i,
  applytojob: /applytojob\.com/i,
  breezyhr: /breezy\.hr/i,
  jobvite: /jobvite\.com/i,
  recruitee: /recruitee\.com/i,
};

const PLATFORM_DESC_DOMAINS_BY_SOURCE: Record<string, string[]> = {
  linkedin: ["linkedin.com"],
  reed: ["reed.co.uk"],
  jooble: ["jooble.org"],
  devitjobs: ["devitjobs.uk"],
  hn_hiring: ["news.ycombinator.com"],
  remoteok: ["remoteok.com"],
};

const GLOBAL_PLATFORM_DESC_DOMAINS = [
  "jooble.org",
  "linkedin.com",
  "reed.co.uk",
  "devitjobs.uk",
  "remoteok.com",
  "news.ycombinator.com",
];

const BLOCKED_CONTENT_PATTERNS = [
  /access denied/i,
  /temporarily blocked/i,
  /unusual traffic/i,
  /verify you are human/i,
  /cloudflare/i,
  /captcha/i,
  /403 forbidden/i,
];

const LOGIN_CONTENT_PATTERNS = [
  /sign in/i,
  /log in/i,
  /continue with google/i,
  /continue with linkedin/i,
];

interface PageSignals {
  title: string;
  bodyText: string;
}

interface ExternalApplyHint {
  url: string;
  score: number;
  reason: string;
}

function toAbsoluteUrl(baseUrl: string, maybeRelativeUrl: string | null | undefined): string | null {
  if (!maybeRelativeUrl) return null;
  const raw = maybeRelativeUrl.trim();
  if (!raw) return null;
  if (raw.startsWith("javascript:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return null;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function classifyUrl(url: string): { isLogin: boolean; isOAuth: boolean; oauthProvider?: string; isRegistration: boolean } {
  const isLogin = LOGIN_PATTERNS.some(p => p.test(url));
  const isGoogleOAuth = OAUTH_GOOGLE_PATTERNS.some(p => p.test(url));
  const isLinkedInOAuth = OAUTH_LINKEDIN_PATTERNS.some(p => p.test(url));
  const isRegistration = REGISTRATION_PATTERNS.some(p => p.test(url));

  return {
    isLogin: isLogin || isGoogleOAuth || isLinkedInOAuth,
    isOAuth: isGoogleOAuth || isLinkedInOAuth,
    oauthProvider: isGoogleOAuth ? "google" : isLinkedInOAuth ? "linkedin" : undefined,
    isRegistration,
  };
}

function detectAtsProvider(url: string): string | undefined {
  for (const [name, pattern] of Object.entries(ATS_PROVIDERS)) {
    if (pattern.test(url)) return name;
  }
  return undefined;
}

function isPlatformDescOnly(url: string, source: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const sourceDomains = PLATFORM_DESC_DOMAINS_BY_SOURCE[source] ?? [];
    return [...sourceDomains, ...GLOBAL_PLATFORM_DESC_DOMAINS].some((d) => hostname.includes(d));
  } catch {
    return false;
  }
}

function isExternalCandidate(url: string, source: string): boolean {
  if (!url.startsWith("http")) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const sourceDomains = PLATFORM_DESC_DOMAINS_BY_SOURCE[source] ?? [];
    const platformDomains = [...sourceDomains, ...GLOBAL_PLATFORM_DESC_DOMAINS];
    return !platformDomains.some((domain) => hostname.includes(domain));
  } catch {
    return false;
  }
}

function scoreExternalApplyHints(
  source: string,
  finalUrl: string,
  rawHints: {
    metaRefreshUrl?: string;
    jsLocationHints?: string[];
    visibleApplyLinks?: Array<{ href: string; text: string; className: string }>;
  },
): ExternalApplyHint[] {
  const hints: ExternalApplyHint[] = [];

  const metaRefresh = toAbsoluteUrl(finalUrl, rawHints.metaRefreshUrl);
  if (metaRefresh && isExternalCandidate(metaRefresh, source)) {
    hints.push({ url: metaRefresh, score: 90, reason: "meta_refresh" });
  }

  for (const jsHintRaw of rawHints.jsLocationHints ?? []) {
    const jsHint = toAbsoluteUrl(finalUrl, jsHintRaw);
    if (!jsHint || !isExternalCandidate(jsHint, source)) continue;
    let score = 70;
    if (/apply|career|jobs|job\/|greenhouse|lever|workday|ashby|smartrecruiters|icims/i.test(jsHint)) {
      score += 15;
    }
    hints.push({ url: jsHint, score, reason: "js_location_hint" });
  }

  for (const link of rawHints.visibleApplyLinks ?? []) {
    const abs = toAbsoluteUrl(finalUrl, link.href);
    if (!abs || !isExternalCandidate(abs, source)) continue;
    const text = `${link.text} ${link.className}`.toLowerCase();
    let score = 40;
    if (/apply|apply now|start application|continue application|candidate/i.test(text)) score += 35;
    if (/career|jobs|greenhouse|lever|workday|ashby|smartrecruiters|icims|bamboo/i.test(abs)) score += 20;
    hints.push({ url: abs, score, reason: "visible_apply_link" });
  }

  const bestByUrl = new Map<string, ExternalApplyHint>();
  for (const hint of hints) {
    const existing = bestByUrl.get(hint.url);
    if (!existing || hint.score > existing.score) {
      bestByUrl.set(hint.url, hint);
    }
  }
  return Array.from(bestByUrl.values()).sort((a, b) => b.score - a.score);
}

async function readExternalApplyHints(page: Page): Promise<{
  metaRefreshUrl?: string;
  jsLocationHints?: string[];
  visibleApplyLinks?: Array<{ href: string; text: string; className: string }>;
}> {
  try {
    return await page.evaluate(READ_REDIRECT_HINTS_SCRIPT) as {
      metaRefreshUrl?: string;
      jsLocationHints?: string[];
      visibleApplyLinks?: Array<{ href: string; text: string; className: string }>;
    };
  } catch {
    return {};
  }
}

async function readPageSignals(page: Page): Promise<PageSignals> {
  try {
    const result = await page.evaluate(READ_PAGE_SIGNALS_SCRIPT) as PageSignals;
    return result;
  } catch {
    return { title: "", bodyText: "" };
  }
}

export async function resolveApplyUrl(
  page: Page,
  startUrl: string,
  source: string,
  options: { timeoutMs?: number } = {},
): Promise<ApplyResolutionResult> {
  const { timeoutMs = 20000 } = options;

  const redirectChain: RedirectStep[] = [];
  let currentUrl = startUrl;
  let loginRequired = false;
  let registrationRequired = false;
  let oauthProvider: string | undefined;
  let formProvider: string | undefined;

  try {
    let response = await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    let finalUrl = page.url();
    currentUrl = finalUrl;

    if (response) {
      const chain = response.request().redirectedFrom();
      let req = chain;
      while (req) {
        redirectChain.push({ url: req.url(), status: (await req.response())?.status() });
        req = req.redirectedFrom();
      }
      redirectChain.push({ url: finalUrl, status: response.status() });
    }

    let urlClassification = classifyUrl(finalUrl);
    let pageSignals = await readPageSignals(page);
    loginRequired = urlClassification.isLogin;
    registrationRequired = urlClassification.isRegistration;
    oauthProvider = urlClassification.oauthProvider;
    formProvider = detectAtsProvider(finalUrl);

    if (isPlatformDescOnly(finalUrl, source)) {
      const rawHints = await readExternalApplyHints(page);
      const hints = scoreExternalApplyHints(source, finalUrl, rawHints);
      const bestHint = hints[0];
      if (bestHint) {
        try {
          const hintResponse = await page.goto(bestHint.url, {
            waitUntil: "domcontentloaded",
            timeout: Math.min(timeoutMs, 15000),
          });
          const hintedFinalUrl = page.url();
          if (hintedFinalUrl && hintedFinalUrl !== finalUrl) {
            redirectChain.push({ url: bestHint.url, status: hintResponse?.status(), provider: bestHint.reason });
            redirectChain.push({ url: hintedFinalUrl, status: hintResponse?.status() });
            finalUrl = hintedFinalUrl;
            currentUrl = hintedFinalUrl;
            urlClassification = classifyUrl(finalUrl);
            pageSignals = await readPageSignals(page);
            formProvider = detectAtsProvider(finalUrl) ?? formProvider;
            loginRequired = urlClassification.isLogin;
            registrationRequired = urlClassification.isRegistration;
            oauthProvider = urlClassification.oauthProvider;
          }
        } catch {
          // best hint unreachable — keep original resolution path
        }
      }
    }

    const blockedByContent = BLOCKED_CONTENT_PATTERNS.some((p) => p.test(`${pageSignals.title}\n${pageSignals.bodyText}`));
    if (blockedByContent) {
      return {
        status: "blocked",
        resolvedUrl: finalUrl,
        redirectChain,
        loginRequired: false,
        registrationRequired: false,
        formProvider,
      };
    }

    if (urlClassification.isOAuth) {
      const status: ApplyDiscoveryStatus = oauthProvider === "google" ? "oauth_google" : "oauth_linkedin";
      return {
        status,
        resolvedUrl: finalUrl,
        redirectChain,
        loginRequired: true,
        registrationRequired: false,
        oauthProvider,
        formProvider,
      };
    }

    if (urlClassification.isLogin && !urlClassification.isOAuth) {
      return {
        status: "requires_login",
        resolvedUrl: finalUrl,
        redirectChain,
        loginRequired: true,
        registrationRequired,
        oauthProvider,
        formProvider,
      };
    }

    if (urlClassification.isRegistration) {
      return {
        status: "requires_registration",
        resolvedUrl: finalUrl,
        redirectChain,
        loginRequired: false,
        registrationRequired: true,
        formProvider,
      };
    }

    if (!loginRequired) {
      const loginByContent = LOGIN_CONTENT_PATTERNS.some((p) => p.test(`${pageSignals.title}\n${pageSignals.bodyText}`));
      if (loginByContent) {
        return {
          status: "requires_login",
          resolvedUrl: finalUrl,
          redirectChain,
          loginRequired: true,
          registrationRequired: false,
          oauthProvider,
          formProvider,
        };
      }
    }

    const formSchema = await extractFormSchema(page);
    if (formSchema && (formSchema.fieldCount > 0 || formSchema.hasResumeUpload)) {
      return {
        status: "final_form_reached",
        resolvedUrl: finalUrl,
        finalFormUrl: finalUrl,
        redirectChain,
        loginRequired: false,
        registrationRequired: false,
        formSchema,
        formProvider: formProvider ?? formSchema.formTitle,
      };
    }

    if (isPlatformDescOnly(finalUrl, source)) {
      return {
        status: "platform_desc_only",
        resolvedUrl: finalUrl,
        redirectChain,
        loginRequired: false,
        registrationRequired: false,
        formProvider,
      };
    }

    if (redirectChain.length > 2) {
      return {
        status: "intermediate_redirect",
        resolvedUrl: finalUrl,
        redirectChain,
        loginRequired: false,
        registrationRequired: false,
        formProvider,
      };
    }

    return {
      status: "platform_desc_only",
      resolvedUrl: finalUrl,
      redirectChain,
      loginRequired: false,
      registrationRequired: false,
      formProvider,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ startUrl, source, err: message }, "Apply resolution failed");

    if (message.includes("net::ERR_") || message.includes("Timeout")) {
      return {
        status: "blocked",
        resolvedUrl: currentUrl,
        redirectChain,
        loginRequired,
        registrationRequired,
        error: message,
      };
    }

    return {
      status: "failed",
      resolvedUrl: currentUrl,
      redirectChain,
      loginRequired,
      registrationRequired,
      error: message,
    };
  }
}

const EXTRACT_FORM_SCRIPT = `
(() => {
  const forms = document.querySelectorAll("form");
  if (forms.length === 0) {
    const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (!submitBtn) return null;
  }
  const targetForm = forms.length > 0 ? forms[0] : document.body;
  const inputs = targetForm.querySelectorAll("input, select, textarea");
  const fields = [];
  inputs.forEach(input => {
    if (input.type === "hidden" || input.type === "submit") return;
    const labelEl = input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
    fields.push({
      name: input.name || input.id || "",
      type: input.type || input.tagName.toLowerCase(),
      label: (labelEl && labelEl.textContent ? labelEl.textContent.trim() : null) || input.placeholder || undefined,
      required: input.required || input.getAttribute("aria-required") === "true",
    });
  });
  const hasResumeUpload = !!targetForm.querySelector('input[type="file"], [name*="resume"], [name*="cv"]');
  const hasRequiredFields = fields.some(f => f.required);
  const steps = document.querySelectorAll('[class*="step"], [data-step], [role="progressbar"]');
  const formTitle = (forms[0] && forms[0].getAttribute("aria-label"))
    || (document.querySelector("h1, h2, [class*='title']") || {}).textContent || undefined;
  const formAction = forms.length > 0 ? forms[0].action : undefined;
  return { formTitle, formAction, hasResumeUpload, hasRequiredFields, isMultiStep: steps.length > 1, fieldCount: fields.length, fields };
})()
`;

const READ_PAGE_SIGNALS_SCRIPT = `
(() => {
  const title = document.title ?? "";
  const bodyText = document.body?.innerText?.slice(0, 5000) ?? "";
  return { title, bodyText };
})()
`;

const READ_REDIRECT_HINTS_SCRIPT = `
(() => {
  const metaRefresh = document.querySelector('meta[http-equiv="refresh" i]');
  let metaRefreshUrl = "";
  if (metaRefresh) {
    const content = metaRefresh.getAttribute("content") || "";
    const match = content.match(/url\\s*=\\s*([^;]+)/i);
    if (match && match[1]) metaRefreshUrl = match[1].trim().replace(/^['"]|['"]$/g, "");
  }

  const jsLocationHints = [];
  const scriptNodes = Array.from(document.querySelectorAll("script")).slice(0, 30);
  const regexes = [
    /location\\.href\\s*=\\s*['"]([^'"]+)['"]/gi,
    /window\\.location\\s*=\\s*['"]([^'"]+)['"]/gi,
    /location\\.replace\\(\\s*['"]([^'"]+)['"]\\s*\\)/gi
  ];
  for (const node of scriptNodes) {
    const text = node.textContent || "";
    if (!text) continue;
    for (const re of regexes) {
      let match;
      while ((match = re.exec(text)) !== null) {
        if (match[1]) jsLocationHints.push(match[1].trim());
      }
    }
  }

  const visibleApplyLinks = [];
  const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 300);
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    if (!href) continue;
    const text = (a.textContent || "").trim();
    const className = (typeof a.className === "string" ? a.className : "") || "";
    if (!text && !className) continue;
    visibleApplyLinks.push({ href, text, className });
  }

  return { metaRefreshUrl, jsLocationHints, visibleApplyLinks };
})()
`;

async function extractFormSchema(page: Page): Promise<FormSchemaSnapshot | null> {
  try {
    return await page.evaluate(EXTRACT_FORM_SCRIPT) as FormSchemaSnapshot | null;
  } catch {
    return null;
  }
}
