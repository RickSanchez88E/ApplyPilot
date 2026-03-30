/**
 * HTTP-only apply resolver — no browser needed.
 * 
 * For jobs with apply_discovery_status = 'unresolved', this script:
 * 1. Follows HTTP redirects
 * 2. For known ATS domains (Greenhouse/Lever/Ashby/etc), marks as final_form
 * 3. For others, fetches HTML and detects <form> elements
 * 4. Updates apply_discovery_results directly
 *
 * Much faster than browser-based resolution (~100 jobs/minute).
 */
import { query } from '../src/db/client.js';

const ATS_FORM_DOMAINS: Record<string, RegExp> = {
  greenhouse: /boards\.greenhouse\.io|greenhouse\.io\/.*\/jobs/i,
  lever: /jobs\.lever\.co/i,
  ashby: /jobs\.ashbyhq\.com/i,
  workday: /myworkdayjobs\.com|workday\.com.*\/job\//i,
  smartrecruiters: /jobs\.smartrecruiters\.com/i,
  bamboohr: /\w+\.bamboohr\.com\/careers/i,
  workable: /apply\.workable\.com/i,
  icims: /careers-.*\.icims\.com|icims\.com.*\/jobs/i,
  breezyhr: /\w+\.breezy\.hr/i,
  recruitee: /\w+\.recruitee\.com/i,
  jobvite: /jobs\.jobvite\.com/i,
  applytojob: /\w+\.applytojob\.com/i,
  // CV Library (devitjobs redirects here) — known to have forms
  cvlibrary: /cv-library\.co\.uk\/job\//i,
};

// Patterns that indicate a page has an application form
const FORM_INDICATORS = [
  /<form[^>]*>/i,
  /input[^>]*type=["']?file/i,
  /name=["']?resume/i,
  /name=["']?cv[_-]/i,
  /data-qa=["']?apply/i,
  /id=["']?application/i,
];

const LOGIN_URL_PATTERNS = [
  /\/login/i, /\/signin/i, /\/sign-in/i, /\/auth\//i,
  /accounts\.google\.com/i, /\/sso\//i,
];

const BLOCKED_PATTERNS = [
  /cloudflare/i, /captcha/i, /access.denied/i,
  /403 forbidden/i, /unusual.traffic/i,
];

interface ResolveResult {
  status: string;
  resolvedUrl: string;
  formProvider?: string;
  loginRequired?: boolean;
  error?: string;
  fieldCount?: number;
}

async function resolveViaHttp(url: string): Promise<ResolveResult> {
  try {
    // Follow redirects
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });

    const finalUrl = res.url;

    // Check for login redirect
    if (LOGIN_URL_PATTERNS.some(p => p.test(finalUrl))) {
      return { status: 'requires_login', resolvedUrl: finalUrl, loginRequired: true };
    }

    // Check if final URL is a known ATS form domain
    for (const [provider, pattern] of Object.entries(ATS_FORM_DOMAINS)) {
      if (pattern.test(finalUrl)) {
        // Known ATS — these always have application forms
        // Fetch HTML to get basic form schema
        const html = await res.text();
        const fieldCount = countFormFields(html);
        return {
          status: 'final_form_reached',
          resolvedUrl: finalUrl,
          formProvider: provider,
          fieldCount: fieldCount > 0 ? fieldCount : 5, // ATS forms always have fields
        };
      }
    }

    // Not a known ATS — check HTML for forms
    const html = await res.text();

    // Check for blocked/CAPTCHA
    if (BLOCKED_PATTERNS.some(p => p.test(html.slice(0, 5000)))) {
      return { status: 'blocked', resolvedUrl: finalUrl };
    }

    // Check for login content
    if (/sign.in|log.in|create.account/i.test(html.slice(0, 5000)) &&
        !/<form[^>]*>/i.test(html.slice(0, 50000))) {
      return { status: 'requires_login', resolvedUrl: finalUrl, loginRequired: true };
    }

    // Check for form indicators
    const hasForm = FORM_INDICATORS.some(p => p.test(html));
    if (hasForm) {
      const fieldCount = countFormFields(html);
      if (fieldCount > 0) {
        return {
          status: 'final_form_reached',
          resolvedUrl: finalUrl,
          formProvider: detectProvider(finalUrl),
          fieldCount,
        };
      }
    }

    // Check if it's a company careers/jobs page (could have apply buttons)
    if (/\/careers?|\/jobs?|\/openings?|\/positions?/i.test(finalUrl)) {
      return { status: 'platform_desc_only', resolvedUrl: finalUrl };
    }

    return { status: 'platform_desc_only', resolvedUrl: finalUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
      return { status: 'blocked', resolvedUrl: url, error: msg };
    }
    return { status: 'failed', resolvedUrl: url, error: msg };
  }
}

function countFormFields(html: string): number {
  const inputs = html.match(/<input[^>]*>/gi) ?? [];
  const selects = html.match(/<select[^>]*>/gi) ?? [];
  const textareas = html.match(/<textarea[^>]*>/gi) ?? [];
  // Filter out hidden inputs
  const visibleInputs = inputs.filter(i => !/type=["']?hidden/i.test(i));
  return visibleInputs.length + selects.length + textareas.length;
}

function detectProvider(url: string): string | undefined {
  for (const [name, pattern] of Object.entries(ATS_FORM_DOMAINS)) {
    if (pattern.test(url)) return name;
  }
  return undefined;
}

async function main() {
  const sourceFilter = process.argv[2] || null; // optional: --source=hn_hiring
  
  let filterClause = '';
  const params: unknown[] = [];
  
  if (sourceFilter?.startsWith('--source=')) {
    const source = sourceFilter.split('=')[1];
    params.push(source);
    filterClause = ` AND adr.source = $${params.length}`;
  }

  // Find jobs that need resolution
  const rows = await query<{
    job_key: string;
    source: string;
    apply_url: string;
  }>(`
    SELECT adr.job_key, adr.source, 
           COALESCE(NULLIF(jc.apply_url, ''), NULLIF(jc.canonical_url, '')) as apply_url
    FROM apply_discovery_results adr
    JOIN jobs_current jc ON jc.job_key = adr.job_key
    WHERE adr.apply_discovery_status IN ('unresolved', 'failed', 'intermediate_redirect')
      AND COALESCE(NULLIF(jc.apply_url, ''), NULLIF(jc.canonical_url, '')) IS NOT NULL
      ${filterClause}
    ORDER BY 
      CASE WHEN adr.apply_discovery_status = 'unresolved' THEN 0 ELSE 1 END,
      adr.updated_at ASC
    LIMIT 500
  `, params);

  console.log(`Found ${rows.rows.length} jobs to resolve via HTTP`);

  let finalForm = 0;
  let login = 0;
  let blocked = 0;
  let descOnly = 0;
  let failed = 0;

  for (let i = 0; i < rows.rows.length; i++) {
    const row = rows.rows[i]!;
    const result = await resolveViaHttp(row.apply_url);

    // Update apply_discovery_results
    const formSchema = result.status === 'final_form_reached'
      ? JSON.stringify({
          formTitle: result.formProvider,
          formAction: result.resolvedUrl,
          hasResumeUpload: false,
          hasRequiredFields: true,
          isMultiStep: false,
          fieldCount: result.fieldCount ?? 0,
          fields: [],
        })
      : null;

    await query(`
      UPDATE apply_discovery_results SET
        apply_discovery_status = $1::apply_discovery_status,
        resolved_apply_url = $2,
        final_form_url = $3,
        form_schema_snapshot = $4::jsonb,
        form_provider = $5,
        login_required = $6,
        registration_required = false,
        last_resolution_error = $7,
        resolver_version = '2.0-http',
        updated_at = NOW()
      WHERE job_key = $8
    `, [
      result.status,
      result.resolvedUrl,
      result.status === 'final_form_reached' ? result.resolvedUrl : null,
      formSchema,
      result.formProvider ?? null,
      result.loginRequired ?? false,
      result.error ?? null,
      row.job_key,
    ]);

    // Also update jobs_current.apply_resolution_status
    await query(`
      UPDATE jobs_current SET
        apply_resolution_status = $1,
        updated_at = NOW()
      WHERE job_key = $2
    `, [result.status, row.job_key]);

    switch (result.status) {
      case 'final_form_reached': finalForm++; break;
      case 'requires_login': login++; break;
      case 'blocked': blocked++; break;
      case 'platform_desc_only': descOnly++; break;
      default: failed++;
    }

    if ((i + 1) % 20 === 0) {
      console.log(`  [${i + 1}/${rows.rows.length}] final=${finalForm} login=${login} blocked=${blocked} desc=${descOnly} failed=${failed}`);
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`final_form_reached: ${finalForm}`);
  console.log(`requires_login: ${login}`);
  console.log(`blocked: ${blocked}`);
  console.log(`platform_desc_only: ${descOnly}`);
  console.log(`failed: ${failed}`);

  process.exit(0);
}

main();
