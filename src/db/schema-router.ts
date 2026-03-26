/**
 * Schema router.
 *
 * Maps source names to schema-qualified PostgreSQL tables.
 */
const SOURCE_SCHEMA_MAP: Record<string, string> = {
  linkedin: "src_linkedin",
  devitjobs: "src_devitjobs",
  reed: "src_reed",
  jooble: "src_jooble",
  hn_hiring: "src_hn_hiring",
  remoteok: "src_remoteok",
};

export const ALL_SCHEMAS = Object.values(SOURCE_SCHEMA_MAP);
export const ALL_SOURCE_NAMES = Object.keys(SOURCE_SCHEMA_MAP);

export function sourceTable(source: string): string {
  const schema = SOURCE_SCHEMA_MAP[source];
  if (!schema) {
    throw new Error(`Unknown source: ${source}. Valid sources: ${ALL_SOURCE_NAMES.join(", ")}`);
  }
  return `${schema}.jobs`;
}

export function sourceSchema(source: string): string {
  const schema = SOURCE_SCHEMA_MAP[source];
  if (!schema) {
    throw new Error(`Unknown source: ${source}`);
  }
  return schema;
}

export const JOBS_ALL_VIEW = "public.jobs_all";
export const CONTENT_INDEX_TABLE = "public.content_index";
