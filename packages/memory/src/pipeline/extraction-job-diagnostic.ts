import type { z } from "zod";

export function parseExtractionJobJson<T>(jobJson: string, schema: z.ZodType<T>): T | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(jobJson);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function latestExtractionJobErrorCode<
  T extends { readonly updatedAt: string; readonly lastErrorCode?: string | undefined },
>(
  rows: readonly { readonly jobJson: string }[],
  schema: z.ZodType<T>,
  invalidCode: string,
): string | undefined {
  let latest: T | undefined;
  for (const row of rows) {
    const job = parseExtractionJobJson(row.jobJson, schema);
    if (job === undefined) return invalidCode;
    if (latest === undefined || job.updatedAt > latest.updatedAt) latest = job;
  }
  return latest?.lastErrorCode;
}
