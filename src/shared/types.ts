/**
 * Job source identifiers — each adapter writes its own source tag.
 */
export type JobSource =
  | "linkedin"
  | "devitjobs"
  | "greenhouse"
  | "lever"
  | "reed"
  | "hn_hiring"
  | "remoteok"
  | "wellfound"
  | "gov_uk_sponsor"
  // Deprecated sources — adapter disabled, not in jobs_all view, kept for type compat
  | "jooble";

export interface Job {
  readonly id: bigint;
  readonly linkedinUrl: string | null;
  readonly urlHash: string;
  readonly companyName: string;
  readonly jobTitle: string;
  readonly location: string | null;
  readonly workMode: "remote" | "hybrid" | "onsite" | null;
  readonly salaryText: string | null;
  readonly postedDate: Date | null;
  readonly jdRaw: string;
  readonly jdStructured: JdStructured | null;
  readonly applyType: "easy_apply" | "external" | null;
  readonly applyUrl: string | null;
  readonly atsPlatform: AtsPlatform | null;
  readonly state: JobState;
  readonly stateChangedAt: Date;
  readonly generatedCvId: bigint | null;
  readonly lastError: string | null;
  readonly retryCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  // Multi-source fields
  readonly source: JobSource;
  readonly sourceUrl: string | null;
  readonly contentHash: string | null;
  readonly canSponsor: boolean;
}

export interface JdStructured {
  readonly requirements: string[];
  readonly skills: string[];
  readonly responsibilities: string[];
  readonly qualifications: string[];
}

export type JobState = "pending" | "applied" | "processing" | "ignored" | "suspended";

export type AtsPlatform =
  | "workday"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "breezyhr"
  | "smartrecruiters"
  | "bamboohr"
  | "successfactors"
  | "taleo"
  | "icims"
  | "generic";

export interface NewJob {
  readonly linkedinUrl?: string;
  readonly companyName: string;
  readonly jobTitle: string;
  readonly location?: string;
  readonly workMode?: "remote" | "hybrid" | "onsite";
  readonly salaryText?: string;
  readonly postedDate?: Date;
  readonly jdRaw: string;
  readonly jdStructured?: JdStructured;
  readonly applyType?: "easy_apply" | "external";
  readonly applyUrl?: string;
  readonly atsPlatform?: AtsPlatform;
  // Multi-source fields
  readonly source: JobSource;
  readonly sourceUrl?: string;
}
