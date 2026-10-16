import { z } from "zod";
import {
  ExtractionMemoryTypeSchema,
  ExtractionSearchModeSchema,
  type ExtractionMemoryAccess,
} from "../../retrieval/extraction-memory.ts";
import { SemanticFactExtractorProvenanceSchema } from "@pragma/shared";
import {
  EpisodicExtractionInputSchema,
  EpisodicExtractionOutputSchema,
} from "../../episodic/schema.ts";
import {
  SemanticExtractionInputSchema,
  SemanticExtractionOutputSchema,
  SemanticFactCandidateSchema,
} from "../../semantic/schema.ts";
export const MEMORY_EXTRACTION_LIMITS = Object.freeze({
  initialTokens: 1500,
  responseTokens: 2000,
  deliveredTokens: 32000,
  calls: 64,
  pageSize: 20,
  factLimit: 10,
});
const RefList = z.array(z.string().min(1)).min(1).max(100);
const Claim = z.object({ text: z.string().min(1).max(4000), evidence: RefList }).strict();
export const MemoryExtractionTypeSchema = z.enum(["episodic", "semantic"]);
export type MemoryExtractionType = z.infer<typeof MemoryExtractionTypeSchema>;
export const ConversationExtractionInputSchema = SemanticExtractionInputSchema.extend({
  schemaVersion: z.literal("pragma.memory-conversation-extraction-input/v1"),
  previousEpisode: EpisodicExtractionInputSchema.shape.previousEpisode,
  targets: z.array(MemoryExtractionTypeSchema).min(1).max(2),
  evidenceTypes: z.record(z.string(), z.array(MemoryExtractionTypeSchema).min(1)),
  jobs: z
    .object({
      episodic: z.object({ jobId: z.string(), watermark: z.string() }).strict().optional(),
      semantic: z.object({ jobId: z.string(), watermark: z.string() }).strict().optional(),
    })
    .strict(),
  omittedByType: z
    .object({
      episodic: EpisodicExtractionInputSchema.shape.omittedEvidence.optional(),
      semantic: SemanticExtractionInputSchema.shape.omittedEvidence.optional(),
    })
    .strict()
    .optional(),
})
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.targets).size !== input.targets.length)
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Requested memory types must be unique.",
      });
    for (const type of input.targets)
      if (input.jobs[type] === undefined)
        context.addIssue({
          code: "custom",
          path: ["jobs", type],
          message: "A requested type requires its original delivery identity.",
        });
    const ids = new Set(input.evidence.map((item) => item.messageId));
    for (const id of ids)
      if (input.evidenceTypes[id] === undefined)
        context.addIssue({
          code: "custom",
          path: ["evidenceTypes", id],
          message: "Evidence must declare its authorized memory types.",
        });
    for (const [id, types] of Object.entries(input.evidenceTypes))
      if (
        !ids.has(id) ||
        types.some((type) => !input.targets.includes(type)) ||
        new Set(types).size !== types.length
      )
        context.addIssue({
          code: "custom",
          path: ["evidenceTypes", id],
          message: "Evidence types must be unique requested types of an existing passage.",
        });
  });
export const MemoryExtractionToolSchemas = {
  list_evidence: z
    .object({
      directory: z.enum(["evidence", "subjects"]).default("evidence"),
      cursor: z.number().int().nonnegative().default(0),
      query: z.string().max(200).optional(),
      role: z.string().max(40).optional(),
    })
    .strict(),
  read_evidence: z
    .object({ evidence: z.string().min(1), cursor: z.number().int().nonnegative().default(0) })
    .strict(),
  find_existing_memory: z
    .object({
      query: z.string().max(200).default(""),
      fact: z.string().optional(),
      memory: z.string().optional(),
      mode: ExtractionSearchModeSchema.default("hybrid"),
      type: ExtractionMemoryTypeSchema.default("all"),
      limit: z.number().int().min(1).max(20).default(10),
      cursor: z.number().int().nonnegative().default(0),
    })
    .strict(),
  list_existing_memory: z
    .object({
      directory: z.enum(["properties", "facts", "episodes"]).default("properties"),
      subject: z.string().optional(),
      property: z.string().max(200).optional(),
      conversation: z.string().optional(),
      pageCursor: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(20).default(20),
    })
    .strict()
    .superRefine((args, context) => {
      if (args.directory === "episodes" && args.property !== undefined)
        context.addIssue({
          code: "custom",
          path: ["property"],
          message: "property filters facts/properties, not episodes.",
        });
      if (args.directory !== "episodes" && args.conversation !== undefined)
        context.addIssue({
          code: "custom",
          path: ["conversation"],
          message: "conversation filters episodes only.",
        });
    }),
  submit_fact: z
    .object({
      candidate: z.string().optional(),
      statement: z.string().min(1).max(4000),
      subjects: z.array(z.string()).min(1).max(20),
      property: z.union([
        z.string().min(1),
        z
          .object({
            predicate: SemanticFactCandidateSchema.shape.predicate,
            conflictMode: z.enum(["exclusive", "compatible"]),
          })
          .strict(),
      ]),
      value: z.string().min(1).max(2000),
      confidence: z.number().min(0).max(0.95),
      evidence: RefList,
      replaces: z.string().optional(),
      reviewAt: z.string().datetime().optional(),
      expiresAt: z.string().datetime().optional(),
    })
    .strict(),
  submit_episode_part: z.discriminatedUnion("part", [
    z.object({ part: z.enum(["goal", "summary"]), ...Claim.shape }).strict(),
    z
      .object({
        part: z.literal("attempt"),
        candidate: z.string().optional(),
        description: z.string().min(1).max(2000),
        result: z.string().min(1).max(2000).optional(),
        evidence: RefList,
      })
      .strict(),
    z
      .object({
        part: z.literal("recovery"),
        candidate: z.string().optional(),
        failure: z.string().min(1).max(2000),
        recovery: z.string().min(1).max(2000).optional(),
        evidence: RefList,
      })
      .strict(),
    z
      .object({
        part: z.literal("outcome"),
        status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
        summary: z.string().min(1).max(4000),
        evidence: RefList,
      })
      .strict(),
  ]),
  finish_extraction: z.discriminatedUnion("retain", [
    z
      .object({
        retain: z.literal(true),
        type: MemoryExtractionTypeSchema.optional(),
        language: z.string().min(2).max(32).optional(),
        valueScore: z.number().min(0).max(1).optional(),
      })
      .strict(),
    z
      .object({
        retain: z.literal(false),
        type: MemoryExtractionTypeSchema.optional(),
        reason: z.enum(["low-value", "no-stable-fact", "insufficient-evidence", "sensitive"]),
      })
      .strict(),
  ]),
} as const;
export type MemoryExtractionToolName = keyof typeof MemoryExtractionToolSchemas;
export type MemoryExtractionInput =
  | z.infer<typeof EpisodicExtractionInputSchema>
  | z.infer<typeof SemanticExtractionInputSchema>
  | z.infer<typeof ConversationExtractionInputSchema>;
export const Fact = SemanticExtractionInputSchema.shape.currentFacts.element.extend({
  conflictMode: z.enum(["exclusive", "compatible"]),
});
export type ExtractionExistingFact = z.infer<typeof Fact>;
const Output = z.union([EpisodicExtractionOutputSchema, SemanticExtractionOutputSchema]);
export const ConversationExtractionOutputSchema = z
  .object({
    episodic: EpisodicExtractionOutputSchema.optional(),
    semantic: SemanticExtractionOutputSchema.optional(),
  })
  .strict();
export const Provenance = SemanticFactExtractorProvenanceSchema;
export const State = z
  .object({
    schemaVersion: z.literal("pragma.memory-curator-session/v2"),
    key: z.string(),
    module: z.enum(["episodic", "semantic", "conversation"]),
    jobId: z.string(),
    watermark: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    input: z.union([
      EpisodicExtractionInputSchema,
      SemanticExtractionInputSchema,
      ConversationExtractionInputSchema,
    ]),
    facts: z.array(Fact).max(100),
    read: z.record(z.string(), z.array(z.tuple([z.number(), z.number()]))),
    calls: z.number().int().nonnegative(),
    deliveredTokens: z.number().int().nonnegative(),
    tokenLimit: z.number().int().positive(),
    candidates: z.record(z.string(), SemanticFactCandidateSchema),
    parts: z.record(z.string(), z.unknown()),
    provenance: Provenance.optional(),
    output: Output.optional(),
    results: ConversationExtractionOutputSchema,
    resultProvenance: z
      .object({ episodic: Provenance.optional(), semantic: Provenance.optional() })
      .strict(),
    missionId: z.string().min(1).optional(),
    continuations: z.number().int().min(0).max(3),
    admitted: z.boolean(),
    retryGeneration: z.number().int().nonnegative(),
    contextTypes: z.array(MemoryExtractionTypeSchema).min(1).max(2),
    restartPending: z.boolean(),
    pendingContinuation: z
      .object({
        requestId: z.string().min(1),
        previousExecutionId: z.string().min(1),
        retryAt: z.string().datetime(),
        prompt: z.string().min(1).max(8000),
      })
      .strict()
      .optional(),
    lastError: z.string().optional(),
  })
  .strict();
export type SessionState = z.infer<typeof State>;
export type MemoryExtractionReceipt = {
  output: z.infer<typeof Output>;
  provenance: z.infer<typeof Provenance>;
};
export interface MemoryExtractionSession {
  readonly key: string;
  readonly module: "episodic" | "semantic" | "conversation";
  readonly toolNames: readonly MemoryExtractionToolName[];
  prompt(): string;
  assertCurrent(): Promise<void>;
  call(name: MemoryExtractionToolName, args: unknown): Promise<string>;
  bindMission(missionId: string): Promise<void>;
  setProvenance(value: z.infer<typeof Provenance>): Promise<void>;
  receipt(): Promise<MemoryExtractionReceipt | undefined>;
  receiptFor(type: MemoryExtractionType): Promise<MemoryExtractionReceipt | undefined>;
  completed(): Promise<boolean>;
  pendingTypes(): Promise<readonly MemoryExtractionType[]>;
  executionState(): Promise<
    Pick<
      SessionState,
      "missionId" | "continuations" | "pendingContinuation" | "provenance" | "admitted"
    >
  >;
  markAdmitted(): Promise<void>;
  reserveContinuation(input: {
    previousExecutionId: string;
    prompt: string;
  }): Promise<NonNullable<SessionState["pendingContinuation"]>>;
  acknowledgeContinuation(requestId: string): Promise<void>;
  failure(): Promise<string | undefined>;
  setContextBudget(tokens: number): Promise<void>;
}
export interface MemoryExtractionSessionGuard {
  readonly activeTypes?: readonly MemoryExtractionType[] | undefined;
  readonly assertEvidenceAccess?:
    | ((
        evidence: readonly import("@pragma/shared").MemoryEvidenceEnvelope[],
        type: MemoryExtractionType,
      ) => Promise<void>)
    | undefined;
  readonly onResult?:
    ((type: MemoryExtractionType, receipt: MemoryExtractionReceipt) => Promise<void>) | undefined;
  readonly memory?: ExtractionMemoryAccess | undefined;
  readonly assertAccess?: (() => Promise<void>) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly isCurrent?: (() => Promise<boolean>) | undefined;
  readonly findFacts?: ((query: string) => Promise<readonly ExtractionExistingFact[]>) | undefined;
  readonly canUseFact?: ((id: string, revision: number) => Promise<boolean>) | undefined;
}
export interface MemoryExtractorOptions extends MemoryExtractionSessionGuard {
  readonly onAdmission?: (() => void) | undefined;
  readonly watermark?: string | undefined;
  readonly conversationRef?: import("@pragma/shared").MemorySubjectRef | undefined;
}
export function fail(code: string): never {
  throw Object.assign(new Error(code), { code, retryable: false });
}
