export type ApplyDiscoveryStatus =
  | "unresolved"
  | "platform_desc_only"
  | "intermediate_redirect"
  | "requires_login"
  | "requires_registration"
  | "oauth_google"
  | "oauth_linkedin"
  | "final_form_reached"
  | "blocked"
  | "unsupported"
  | "failed";

export interface RedirectStep {
  url: string;
  status?: number;
  isLogin?: boolean;
  isOAuth?: boolean;
  isForm?: boolean;
  provider?: string;
}

export interface FormSchemaSnapshot {
  formTitle?: string;
  formAction?: string;
  hasResumeUpload: boolean;
  hasRequiredFields: boolean;
  isMultiStep: boolean;
  fieldCount: number;
  fields: FormFieldInfo[];
}

export interface FormFieldInfo {
  name: string;
  type: string;
  label?: string;
  required: boolean;
}

export interface ApplyResolutionResult {
  status: ApplyDiscoveryStatus;
  resolvedUrl?: string;
  finalFormUrl?: string;
  redirectChain: RedirectStep[];
  loginRequired: boolean;
  registrationRequired: boolean;
  oauthProvider?: string;
  formSchema?: FormSchemaSnapshot;
  formProvider?: string;
  error?: string;
}
