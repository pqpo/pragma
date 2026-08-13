import { randomUUID } from "node:crypto";

import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "@pragma/core";
import { validateSkillExtractionCandidate } from "@pragma/memory";
import {
  SkillExtractionCandidateSchema,
  SkillPackageFileSchema,
  SkillPackageSchema,
  type SkillExtractionCandidate,
  type SkillExtractionInput,
  type SkillExtractionOutput,
} from "@pragma/shared";
import { z } from "zod";

import { validateGeneratedSkillPackage } from "./skill-validation.ts";

const MAX_DRAFTS = 3;
const MAX_SUBMIT_ATTEMPTS = 3;

const CandidateContentSchema = SkillExtractionCandidateSchema.shape.content;
const BeginSkillDraftInputSchema = z
  .object({
    content: z
      .object({
        normalizedKey: CandidateContentSchema.shape.normalizedKey,
        applicability: CandidateContentSchema.shape.applicability,
        failureModes: CandidateContentSchema.shape.failureModes,
        recoverySteps: CandidateContentSchema.shape.recoverySteps,
        package: z
          .object({
            name: SkillPackageSchema.shape.name,
            description: SkillPackageSchema.shape.description,
          })
          .strict(),
        replayCases: CandidateContentSchema.shape.replayCases,
        boundaryCase: CandidateContentSchema.shape.boundaryCase,
      })
      .strict(),
    sourceRefs: SkillExtractionCandidateSchema.shape.sourceRefs,
    route: SkillExtractionCandidateSchema.shape.route,
  })
  .strict();

const PutSkillFileInputSchema = z
  .object({
    draftId: z.string().uuid(),
    path: SkillPackageFileSchema.shape.path,
    content: SkillPackageFileSchema.shape.content,
  })
  .strict();

const SubmitSkillDraftInputSchema = z.object({ draftId: z.string().uuid() }).strict();

interface SkillDraft {
  readonly id: string;
  readonly metadata: z.infer<typeof BeginSkillDraftInputSchema>;
  readonly files: Map<string, string>;
  submitAttempts: number;
  submitted: boolean;
}

export interface SkillDraftToolError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface SkillDraftSession {
  readonly tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[];
  output(): SkillExtractionOutput | undefined;
  repairExhausted(): boolean;
}

export function createSkillDraftSession(input: SkillExtractionInput): SkillDraftSession {
  const drafts = new Map<string, SkillDraft>();
  const accepted: SkillExtractionCandidate[] = [];
  let exhausted = false;
  let toolQueue: Promise<void> = Promise.resolve();
  const enqueue = (
    operation: () => Promise<ExpertAgentToolCallResult>,
  ): Promise<ExpertAgentToolCallResult> => {
    const result = toolQueue.then(operation);
    toolQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const begin = managedTool(
    "begin_skill_draft",
    "Begin one Skill candidate draft after validating its metadata, provenance, and route.",
    BeginSkillDraftInputSchema,
    async (args) => {
      if (exhausted) return failure([repairBudgetError()], true);
      if (drafts.size >= MAX_DRAFTS) {
        return failure([
          {
            path: "draft",
            code: "draft_limit_reached",
            message: `At most ${MAX_DRAFTS} Skill drafts may be created in one extraction.`,
          },
        ]);
      }
      const parsed = BeginSkillDraftInputSchema.safeParse(args);
      if (!parsed.success) return failure(zodErrors(parsed.error));
      const probe = SkillExtractionCandidateSchema.parse({
        ...parsed.data,
        content: {
          ...parsed.data.content,
          package: { ...parsed.data.content.package, files: [{ path: "SKILL.md", content: "" }] },
        },
      });
      const issues = validateSkillExtractionCandidate(
        probe,
        input.sources,
        input.existingTargets,
        new Set(accepted.map((candidate) => candidate.content.normalizedKey)),
      );
      if (issues.length > 0) return failure(issues);
      const draftId = randomUUID();
      drafts.set(draftId, {
        id: draftId,
        metadata: parsed.data,
        files: new Map(),
        submitAttempts: 0,
        submitted: false,
      });
      return success({ ok: true, draftId });
    },
    enqueue,
  );

  const put = managedTool(
    "put_skill_file",
    "Add or replace one file in the current Skill draft without embedding it in the final response.",
    PutSkillFileInputSchema,
    async (args) => {
      if (exhausted) return failure([repairBudgetError()], true);
      const parsed = PutSkillFileInputSchema.safeParse(args);
      if (!parsed.success) return failure(zodErrors(parsed.error));
      const draft = drafts.get(parsed.data.draftId);
      if (draft === undefined) return failure([unknownDraft()]);
      if (draft.submitted) return failure([submittedDraft()]);
      const pathErrors = validateFilePath(parsed.data.path);
      if (pathErrors.length > 0) return failure(pathErrors);
      if (!draft.files.has(parsed.data.path) && draft.files.size >= 64) {
        return failure([
          {
            path: "content.package.files",
            code: "too_many_files",
            message: "A Skill package may contain at most 64 files.",
          },
        ]);
      }
      draft.files.set(parsed.data.path, parsed.data.content);
      return success({ ok: true, draftId: draft.id, path: parsed.data.path });
    },
    enqueue,
  );

  const submit = managedTool(
    "submit_skill_draft",
    "Validate and submit a complete Skill candidate. Validation errors can be repaired in the same draft.",
    SubmitSkillDraftInputSchema,
    async (args) => {
      if (exhausted) return failure([repairBudgetError()], true);
      const parsed = SubmitSkillDraftInputSchema.safeParse(args);
      if (!parsed.success) return failure(zodErrors(parsed.error));
      const draft = drafts.get(parsed.data.draftId);
      if (draft === undefined) return failure([unknownDraft()]);
      if (draft.submitted) return failure([submittedDraft()]);
      if (draft.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
        exhausted = true;
        return failure([repairBudgetError()], true);
      }
      draft.submitAttempts += 1;
      const candidate = SkillExtractionCandidateSchema.safeParse({
        ...draft.metadata,
        content: {
          ...draft.metadata.content,
          package: {
            ...draft.metadata.content.package,
            files: [...draft.files].map(([path, content]) => ({ path, content })),
          },
        },
      });
      if (!candidate.success) {
        const errors = zodErrors(candidate.error);
        const repairExhausted = draft.submitAttempts >= MAX_SUBMIT_ATTEMPTS;
        exhausted ||= repairExhausted;
        return failure(
          repairExhausted ? [...errors, repairBudgetError()] : errors,
          repairExhausted,
        );
      }
      const packageValidation = await validateGeneratedSkillPackage(candidate.data.content.package);
      const errors = [
        ...validateSkillExtractionCandidate(
          candidate.data,
          input.sources,
          input.existingTargets,
          new Set(accepted.map((item) => item.content.normalizedKey)),
        ),
        ...packageValidation.diagnostics.map((diagnostic) => ({
          path: "content.package",
          code: diagnostic.code,
          message: diagnostic.message,
        })),
      ];
      if (errors.length > 0) {
        const repairExhausted = draft.submitAttempts >= MAX_SUBMIT_ATTEMPTS;
        exhausted ||= repairExhausted;
        return failure(
          repairExhausted ? [...errors, repairBudgetError()] : errors,
          repairExhausted,
        );
      }
      draft.submitted = true;
      accepted.push(candidate.data);
      return success({
        ok: true,
        draftId: draft.id,
        candidateIndex: accepted.length - 1,
        remainingDrafts: MAX_DRAFTS - drafts.size,
      });
    },
    enqueue,
  );

  return {
    tools: [begin, put, submit],
    output: () =>
      accepted.length === 0 ? undefined : { retain: true as const, candidates: accepted },
    repairExhausted: () => exhausted,
  };
}

function managedTool<TSchema extends z.ZodType>(
  name: string,
  description: string,
  schema: TSchema,
  call: (args: unknown) => Promise<ExpertAgentToolCallResult>,
  enqueue: (
    operation: () => Promise<ExpertAgentToolCallResult>,
  ) => Promise<ExpertAgentToolCallResult>,
): ExpertAgentManagedTool<string, ExpertAgentToolCallResult> {
  return {
    name,
    description,
    inputSchema: z.toJSONSchema(schema),
    approval: { mode: "none" },
    async call(args, signal) {
      return await enqueue(async () => {
        signal?.throwIfAborted();
        return await call(args);
      });
    },
  };
}

function success(value: unknown): ExpertAgentToolCallResult {
  return { text: JSON.stringify(value), details: value };
}

function failure(
  errors: readonly SkillDraftToolError[],
  repairExhausted = false,
): ExpertAgentToolCallResult {
  const value = { ok: false as const, errors, ...(repairExhausted ? { repairExhausted } : {}) };
  return { text: JSON.stringify(value), details: value };
}

function zodErrors(error: z.ZodError): readonly SkillDraftToolError[] {
  return error.issues.map((issue) => ({
    path: issue.path
      .map((part, index) =>
        typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`,
      )
      .join(""),
    code: issue.code,
    message: issue.message,
  }));
}

function validateFilePath(path: string): readonly SkillDraftToolError[] {
  if (
    path !== "SKILL.md" &&
    !path.startsWith("references/") &&
    !path.startsWith("scripts/") &&
    !path.startsWith("tests/")
  ) {
    return [
      {
        path: "path",
        code: "file_location_invalid",
        message: "Files must be SKILL.md or live under references/, scripts/, or tests/.",
      },
    ];
  }
  if ((path.startsWith("scripts/") || path.startsWith("tests/")) && !path.endsWith(".mjs")) {
    return [
      {
        path: "path",
        code: "executable_extension_invalid",
        message: "Generated executable files must use the .mjs extension.",
      },
    ];
  }
  return [];
}

function unknownDraft(): SkillDraftToolError {
  return { path: "draftId", code: "draft_not_found", message: "The Skill draft was not found." };
}

function submittedDraft(): SkillDraftToolError {
  return {
    path: "draftId",
    code: "draft_already_submitted",
    message: "A submitted Skill draft is immutable.",
  };
}

function repairBudgetError(): SkillDraftToolError {
  return {
    path: "draftId",
    code: "skill_draft_repair_exhausted",
    message: `The Skill draft exhausted its ${MAX_SUBMIT_ATTEMPTS} submission attempts.`,
  };
}
