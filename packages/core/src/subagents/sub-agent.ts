export type SubAgentModel = "inherit" | (string & {});

export interface SubAgentPromptContext {
  readonly parentAgentId: string;
  readonly parentName: string;
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
