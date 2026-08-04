export interface HandoffContextVisibilityRequest {
  readonly currentExecutionId: string;
  readonly owner:
    | { readonly type: "expert-session"; readonly ownerId: string }
    | { readonly type: "flow-execution"; readonly ownerId: string };
}

export type HandoffContextVisibilityResolver = (
  request: HandoffContextVisibilityRequest,
) => Promise<readonly string[]> | readonly string[];
