export type SubAgentModel = "inherit" | (string & {});

export type SubAgentContextBudget = number | false | "inherit";

export type SubAgentThinkingLevel = "inherit" | "off" | "low" | "medium" | "high";

export interface SubAgentPromptContext {
  readonly parentAgentId: string;
  readonly parentDisplayName: string;
  readonly subAgentType: string;
}

export interface SubAgentDefinition {
  /** Unique identifier used by the model to select this subAgent. */
  readonly agentType: string;
  /** Usage guidance injected into tool/runtime descriptions for model routing. */
  readonly whenToUse: string;
  /** Static or context-derived system prompt for this subAgent. */
  readonly systemPrompt: string | ((context: SubAgentPromptContext) => string);
  /** Allowed tool names. "*" means all inherited tools. Undefined inherits parent tools. */
  readonly tools?: readonly string[] | "*";
  /** Explicitly denied tool names. */
  readonly disallowedTools?: readonly string[];
  /** Model selection. Defaults to "inherit". */
  readonly model?: SubAgentModel;
  /** Maximum execution turns, used by runtimes that support turn limits. */
  readonly maxTurns?: number;
  /** Temperature override. Negative values are treated as undefined by runtimes. */
  readonly temperature?: number;
  /** Thinking-level override. Defaults to provider/runtime behavior. */
  readonly thinkingLevel?: SubAgentThinkingLevel;
  /**
   * Context budget for subAgent runs.
   * "inherit" means inherit parent behavior; false disables compaction/budgeting.
   */
  readonly contextBudget?: SubAgentContextBudget;
}

export interface SubAgentRegistry {
  readonly agents: readonly SubAgentDefinition[];
}

export function resolveSubAgentSystemPrompt(
  definition: SubAgentDefinition,
  context: SubAgentPromptContext
): string {
  if (typeof definition.systemPrompt === "string") {
    return definition.systemPrompt;
  }

  return definition.systemPrompt(context);
}
