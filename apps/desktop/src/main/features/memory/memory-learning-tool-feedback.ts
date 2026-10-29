import { z } from "zod";

export const MemoryLearningToolFeedbackSchema = z.object({
  error: z.string().max(200),
  status: z.enum(["needs_correction", "blocked"]),
  retryable: z.boolean(),
  correction: z.string().max(2000),
  nextCall: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).optional(),
  recovery: z.object({ tool: z.string(), reason: z.string().max(500) }).optional(),
});

/** Model correction is distinct from replaying an unchanged failed Host operation. */
export function memoryLearningToolFeedback(
  error: unknown,
  tool: string,
  args: unknown,
  targetId?: string,
) {
  const code =
    error instanceof z.ZodError
      ? "memory_revision_arguments_invalid"
      : error instanceof Error
        ? error.message
        : "memory_revision_tool_failed";
  const next = (tool: string, args: Record<string, unknown> = {}) => ({ tool, args });
  let correction: string | undefined;
  let nextCall: z.infer<typeof MemoryLearningToolFeedbackSchema>["nextCall"];
  switch (code) {
    case "memory_revision_arguments_invalid":
      correction = `Correct the arguments for ${tool}: ${
        error instanceof z.ZodError
          ? error.issues
              .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
              .join("; ")
              .slice(0, 1200)
          : "See input schema"
      }.`;
      break;
    case "memory_revision_target_changed_or_unread":
      correction =
        "Read the current target with read_learning_target and follow nextOffset, then retry the same start or submission. Preserve the draftId and edits; do not create another asset.";
      nextCall =
        targetId === undefined
          ? next("find_learning_targets")
          : next("read_learning_target", { targetId });
      break;
    case "memory_revision_target_denied":
    case "memory_learning_target_already_exists":
      correction =
        "Discover authorized targets again; copy the exact id for read_learning_target and targetRef for revision start. Read the existing target and revise it instead of creating a duplicate.";
      nextCall = next("find_learning_targets");
      break;
    case "memory_revision_source_denied":
    case "memory_revision_sources_required":
    case "memory_revision_successful_episode_required":
    case "knowledge_learning_topic_immature":
      correction =
        "List and read authorized sources, then select exact supporting handles with select_learning_sources. Skill requires a succeeded Episode; new Knowledge requires two conversations or a succeeded Episode. If the evidence cannot support the change, use finish_memory_learning with an honest accumulate/unsupported reason; never invent support.";
      nextCall = next("list_learning_sources");
      break;
    case "memory_revision_pending":
    case "memory_learning_invalid_wait_target":
      correction =
        "Find the exact pending target. For a related target, call finish_memory_learning with its id as waitForTarget and a concrete reason; preserve submitted drafts and never create a duplicate. Unrelated pending targets do not block other work.";
      nextCall = next("find_learning_targets");
      break;
    case "memory_revision_offset_invalid":
      correction =
        "Restart this read at offset 0, then copy each returned nextOffset exactly; null means the read is complete.";
      if (typeof args === "object" && args !== null) nextCall = next(tool, { ...args, offset: 0 });
      break;
    case "memory_revision_draft_denied":
    case "memory_revision_draft_limit":
    case "memory_revision_submitted_draft_frozen":
      correction =
        "List this Mission's drafts and inspect the exact draftId. Preserve submitted drafts; edit and submit unfinished owned drafts. At most three drafts may be owned at once.";
      nextCall = next(
        tool.startsWith("skill_") ? "skill_revision_list_drafts" : "knowledge_revision_list_drafts",
      );
      break;
    case "memory_revision_read_failed":
      correction =
        "Repair the failed read/list/search call using its error feedback and retry that call successfully before finishing. Do not hide a read failure as an unsupported or no-change decision.";
      break;
  }
  return MemoryLearningToolFeedbackSchema.parse({
    error: code.slice(0, 200),
    status: correction === undefined ? "blocked" : "needs_correction",
    retryable: correction !== undefined,
    correction:
      correction === undefined
        ? "Stop this extraction and report the failure. Preserve drafts and evidence. Do not repeat unchanged calls, bypass permissions, or record a no-change decision for a tool, identity or budget failure."
        : `${correction} Follow this correction in the current context; do not repeat unchanged failing calls.`,
    ...(nextCall === undefined
      ? {}
      : { nextCall, recovery: { tool: nextCall.tool, reason: correction!.slice(0, 500) } }),
  });
}
