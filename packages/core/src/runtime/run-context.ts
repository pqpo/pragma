export interface ExpertAgentRunSource {
  readonly type: string;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
}

export interface ExpertAgentRunContext {
  readonly source?: ExpertAgentRunSource | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export function createExpertAgentRunContext(
  context: ExpertAgentRunContext | undefined = undefined,
): ExpertAgentRunContext {
  return {
    source: {
      type: "system",
      ...(context?.source ?? {}),
    },
    attributes: {
      ...(context?.attributes ?? {}),
    },
  };
}
