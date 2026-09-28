import { z } from "zod";
import type { MemoryAttentionEntry } from "./state.ts";

export const MemoryAttentionInputSchema = z
  .object({
    missionId: z.string().min(1),
    contextId: z.string().min(1),
    missionGoal: z.string().max(2_000),
    latestObservation: z.string().max(4_096),
    lastAction: z.string().max(200),
    trigger: z.enum(["new_error", "new_observation", "goal_changed"]),
    concepts: z.array(z.string().min(1).max(128)).max(16),
  })
  .strict();
export type MemoryAttentionInput = z.infer<typeof MemoryAttentionInputSchema>;
export interface MemoryAttentionCandidate {
  readonly module: "episodic" | "semantic";
  readonly memoryId: string;
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
}
export const RecallDecisionSchema = z
  .object({
    recall: z.number().min(0).max(1),
    episodic: z.number().min(0).max(1),
    semantic: z.number().min(0).max(1),
  })
  .strict();
export const CandidateDecisionSchema = z
  .array(
    z
      .object({
        key: z.string(),
        relevance: z.number().min(0).max(1),
        novelty: z.number().min(0).max(1),
      })
      .strict(),
  )
  .max(16);
export interface MemoryDecisionProvider {
  assessRecall(
    input: MemoryAttentionInput,
    signal: AbortSignal,
    beforeRequest?: () => Promise<void>,
  ): Promise<z.infer<typeof RecallDecisionSchema>>;
  assessCandidates(
    input: {
      delta: MemoryAttentionInput;
      candidates: readonly MemoryAttentionCandidate[];
      active: readonly MemoryAttentionEntry[];
    },
    signal: AbortSignal,
    beforeRequest?: () => Promise<void>,
  ): Promise<z.infer<typeof CandidateDecisionSchema>>;
  assessAttention(
    input: {
      delta: MemoryAttentionInput;
      previous: readonly MemoryAttentionEntry[];
      next: readonly MemoryAttentionEntry[];
      candidates: readonly MemoryAttentionCandidate[];
    },
    signal: AbortSignal,
    beforeRequest?: () => Promise<void>,
  ): Promise<boolean>;
}
export function attentionCandidateKey(
  candidate: Pick<MemoryAttentionCandidate, "module" | "memoryId">,
): string {
  return `${candidate.module}:${candidate.memoryId}`;
}
