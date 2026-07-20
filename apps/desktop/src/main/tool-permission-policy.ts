import type {
  ExpertAgentAutomaticHumanInteractionHandler,
  ExpertAgentHumanRequest,
  ExpertAgentHumanResponse,
} from "@pragma/core";

import type { DesktopToolPermissionMode } from "../shared/desktop-api.ts";

const READ_ONLY_TOOL_PREFIX =
  /^(?:get|list|read|search|find|inspect|view|show|describe|preview|validate|check)(?:_|$)/;
const READ_ONLY_TOOL_NAMES = new Set(["glob", "grep", "webfetch", "websearch", "ls", "pwd"]);

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
  if (isReadOnlyToolName(request.toolName) || mode !== "request-approval") {
    return {
      kind: "tool_approval",
      approved: true,
      updatedInput: request.input,
    };
  }
  return undefined;
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return READ_ONLY_TOOL_NAMES.has(normalized) || READ_ONLY_TOOL_PREFIX.test(normalized);
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  const delimiter = normalized.lastIndexOf("__");
  return (delimiter < 0 ? normalized : normalized.slice(delimiter + 2)).replaceAll("-", "_");
}
