import type {
  ExpertAgentAutomaticHumanInteractionHandler,
  ExpertAgentHumanRequest,
  ExpertAgentHumanResponse,
} from "@pragma/core";

import type { DesktopToolPermissionMode } from "../../../shared/contracts/index.ts";

export function createAutomaticToolPermissionHandler(
  getMode: () => DesktopToolPermissionMode | Promise<DesktopToolPermissionMode>,
): ExpertAgentAutomaticHumanInteractionHandler {
  return async (request) => {
    if (request.kind !== "tool_approval") return undefined;
    const mode = await getMode();
    return resolveAutomaticToolPermission(mode, request);
  };
}

export function resolveAutomaticToolPermission(
  mode: DesktopToolPermissionMode,
  request: ExpertAgentHumanRequest,
): ExpertAgentHumanResponse | undefined {
  if (request.kind !== "tool_approval") return undefined;
  if (mode !== "request-approval") {
    return {
      kind: "tool_approval",
      approved: true,
      updatedInput: request.input,
    };
  }
  return undefined;
}
