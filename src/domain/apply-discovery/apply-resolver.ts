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

const PLATFORM_DESC_DOMAINS = [
  "jooble.org", "linkedin.com", "reed.co.uk", "devitjobs.uk",
  "remoteok.com", "news.ycombinator.com",
];

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

function isPlatformDescOnly(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return PLATFORM_DESC_DOMAINS.some(d => hostname.includes(d));
  } catch {
    return false;
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
    const response = await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const finalUrl = page.url();
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

    const urlClassification = classifyUrl(finalUrl);
    loginRequired = urlClassification.isLogin;
    registrationRequired = urlClassification.isRegistration;
    oauthProvider = urlClassification.oauthProvider;
    formProvider = detectAtsProvider(finalUrl);

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

    if (isPlatformDescOnly(finalUrl)) {
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

async function extractFormSchema(page: Page): Promise<FormSchemaSnapshot | null> {
  try {
    return await page.evaluate(EXTRACT_FORM_SCRIPT) as FormSchemaSnapshot | null;
  } catch {
    return null;
  }
}
