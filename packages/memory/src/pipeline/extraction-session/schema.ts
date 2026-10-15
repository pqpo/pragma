import { z } from "zod";
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
      cursor: z.number().int().nonnegative().default(0),
    })
    .strict(),
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
        language: z.string().min(2).max(32).optional(),
        valueScore: z.number().min(0).max(1).optional(),
      })
      .strict(),
    z
      .object({
        retain: z.literal(false),
        reason: z.enum(["low-value", "no-stable-fact", "insufficient-evidence", "sensitive"]),
      })
      .strict(),
  ]),
} as const;
export type MemoryExtractionToolName = keyof typeof MemoryExtractionToolSchemas;
export type MemoryExtractionInput =
  z.infer<typeof EpisodicExtractionInputSchema> | z.infer<typeof SemanticExtractionInputSchema>;
export const Fact = SemanticExtractionInputSchema.shape.currentFacts.element.extend({
  conflictMode: z.enum(["exclusive", "compatible"]),
});
export type ExtractionExistingFact = z.infer<typeof Fact>;
const Output = z.union([EpisodicExtractionOutputSchema, SemanticExtractionOutputSchema]);
export const Provenance = SemanticFactExtractorProvenanceSchema;
export const State = z
  .object({
    schemaVersion: z.literal("pragma.memory-curator-session/v1"),
    key: z.string(),
    module: z.enum(["episodic", "semantic"]),
    jobId: z.string(),
    watermark: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    input: z.union([EpisodicExtractionInputSchema, SemanticExtractionInputSchema]),
    facts: z.array(Fact).max(100),
    read: z.record(z.string(), z.array(z.tuple([z.number(), z.number()]))),
    calls: z.number().int().nonnegative(),
    deliveredTokens: z.number().int().nonnegative(),
    tokenLimit: z.number().int().positive(),
    candidates: z.record(z.string(), SemanticFactCandidateSchema),
    parts: z.record(z.string(), z.unknown()),
    provenance: Provenance.optional(),
    output: Output.optional(),
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
  readonly module: "episodic" | "semantic";
  readonly toolNames: readonly MemoryExtractionToolName[];
  prompt(): string;
  assertCurrent(): Promise<void>;
  call(name: MemoryExtractionToolName, args: unknown): Promise<string>;
  bindMission(missionId: string): Promise<void>;
  setProvenance(value: z.infer<typeof Provenance>): Promise<void>;
  receipt(): Promise<MemoryExtractionReceipt | undefined>;
  failure(): Promise<string | undefined>;
  setContextBudget(tokens: number): Promise<void>;
}
export interface MemoryExtractionSessionGuard {
  readonly assertAccess?: (() => Promise<void>) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly isCurrent?: (() => Promise<boolean>) | undefined;
  readonly findFacts?: ((query: string) => Promise<readonly ExtractionExistingFact[]>) | undefined;
  readonly canUseFact?: ((id: string, revision: number) => Promise<boolean>) | undefined;
}
export interface MemoryExtractorOptions extends MemoryExtractionSessionGuard {
  readonly watermark?: string | undefined;
}
export function fail(code: string): never {
  throw Object.assign(new Error(code), { code, retryable: false });
}
