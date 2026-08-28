import { z } from "zod";

export const M10_SCENARIO_IDS = [
  "E01",
  "E02",
  "E03",
  "E04",
  "E05",
  "E06",
  "E07",
  "E08",
  "E09",
  "E10",
  "E11",
  "E12",
  "E13",
  "E14",
  "E15",
] as const;

export const M10ScenarioIdSchema = z.enum(M10_SCENARIO_IDS);

export const M10ProcessEvidenceSchema = z.object({
  format: z.literal("pragma.m10.evidence/v1"),
  scenarioId: M10ScenarioIdSchema,
  status: z.enum(["passed", "failed"]),
  command: z.object({
    executable: z.string().min(1),
    args: z.array(z.string()),
  }),
  reproductionCommand: z.string().min(1),
  commit: z.string().min(1),
  runtime: z.object({
    node: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
  }),
  timing: z.object({
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().nonnegative(),
  }),
  process: z.object({
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
  }),
  isolation: z.object({
    root: z.string().min(1),
    pragmaHome: z.string().min(1),
    workspace: z.string().min(1),
    npmPrefix: z.string().min(1),
    cleanup: z.enum(["completed", "preserved"]),
  }),
  output: z.object({
    stdout: z.string(),
    stderr: z.string(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
  }),
});

export type M10ProcessEvidence = z.infer<typeof M10ProcessEvidenceSchema>;
