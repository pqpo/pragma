import { z } from "zod";

export const UsagePeriodSchema = z.enum(["7d", "30d", "all"]);
export const UsageSubjectKindSchema = z.enum(["mission", "expert", "team", "flow"]);

export const UsageTokenTotalsSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export const UsageOverviewRequestSchema = z.object({
  period: UsagePeriodSchema.default("30d"),
});

export const UsageDailyPointSchema = UsageTokenTotalsSchema.extend({
  date: z.string().date(),
});

export const UsageOverviewSchema = z.object({
  revision: z.number().int().nonnegative(),
  trackingStartedAt: z.string().datetime(),
  timezone: z.string().min(1),
  totals: UsageTokenTotalsSchema,
  daily: UsageDailyPointSchema.array(),
});

export const UsageSubjectListRequestSchema = z.object({
  period: UsagePeriodSchema.default("30d"),
  kind: UsageSubjectKindSchema,
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

export const UsageSubjectItemSchema = z.object({
  kind: UsageSubjectKindSchema,
  id: z.string().min(1),
  name: z.string().min(1),
  deleted: z.boolean(),
  usage: UsageTokenTotalsSchema,
  share: z.number().min(0).max(1),
});

export const UsageSubjectListSchema = z.object({
  revision: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  items: UsageSubjectItemSchema.array(),
});

export const MissionUsageRequestSchema = z.object({
  missionId: z.string().min(1),
});

export const MissionUsageSchema = z.object({
  revision: z.number().int().nonnegative(),
  trackingStartedAt: z.string().datetime(),
  usage: UsageTokenTotalsSchema,
});

export const UsageUpdateSchema = z.object({
  revision: z.number().int().nonnegative(),
  missionId: z.string().min(1).optional(),
});

export type UsagePeriod = z.infer<typeof UsagePeriodSchema>;
export type UsageSubjectKind = z.infer<typeof UsageSubjectKindSchema>;
export type UsageTokenTotals = z.infer<typeof UsageTokenTotalsSchema>;
export type UsageDailyPoint = z.infer<typeof UsageDailyPointSchema>;
export type UsageSubjectItem = z.infer<typeof UsageSubjectItemSchema>;
export type MissionUsageRequest = z.infer<typeof MissionUsageRequestSchema>;
