import { z } from "zod";
import type { MemoryAttentionEntry } from "./state.ts";

export const MemoryAttentionInputSchema = z
  .object({
    missionId: z.string().min(1),
    contextId: z.string().min(1),
    taskVersion: z.number().int().nonnegative().optional(),
    currentGoal: z.string().max(2_000).optional(),
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
  readonly similarity?: number;
  readonly confidence?: number;
  readonly selectedPaths?: MemoryAttentionEntry["selectedPaths"] | undefined;
  readonly relations?: readonly { module: "episodic" | "semantic"; memoryId: string }[];
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
        confidence: z.number().min(0).max(1).optional(),
      })
      .strict(),
  )
  .max(30)
  .superRefine((values, context) => {
    const keys = new Set<string>();
    values.forEach((value, index) => {
      if (keys.has(value.key))
        context.addIssue({
          code: "custom",
          message: "Duplicate candidate key",
          path: [index, "key"],
        });
      keys.add(value.key);
    });
  });
export interface MemoryDecisionProvider {
  chooseExpansion?(
    input: {
      delta: MemoryAttentionInput;
      candidates: readonly MemoryAttentionCandidate[];
      actions: readonly { id: string; kind: "detail" | "expand"; candidateKey: string }[];
    },
    signal: AbortSignal,
    beforeRequest?: () => Promise<void>,
  ): Promise<string | undefined>;
  assessRecall(
    input: MemoryAttentionInput,
    signal: AbortSignal,
    beforeRequest?: () => Promise<void>,
  ): Promise<z.infer<typeof RecallDecisionSchema>>;
  /** Return exactly one decision for each input candidate, with no additional keys.
   * Decisions apply only to this request's candidate snapshots and revisions.
   */
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
