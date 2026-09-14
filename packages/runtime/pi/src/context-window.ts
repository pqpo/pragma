import { DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS } from "@pragma/shared";

export const DEFAULT_PI_AGENT_CONTEXT_WINDOW_TOKENS = DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS;

/**
 * Pi uses a model's `contextWindow` to drive its native compaction and usage
 * accounting. Keep the provider model's capability unchanged, but project the
 * Agent's working budget onto the Pi-native model.
 */
export function resolvePiEffectiveContextWindow(input: {
  readonly agentContextWindow?: number | undefined;
  readonly modelContextWindow: number;
}): number {
  const agentContextWindow = input.agentContextWindow ?? DEFAULT_PI_AGENT_CONTEXT_WINDOW_TOKENS;
  assertPositiveSafeInteger(agentContextWindow, "Agent context window");
  assertPositiveSafeInteger(input.modelContextWindow, "Model context window");
  return Math.min(agentContextWindow, input.modelContextWindow);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}
