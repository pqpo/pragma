import { canUseClaudeCodeRuntime } from "@pragma/runtime-claude-code/availability";
import { canUseCodexRuntime } from "@pragma/runtime-codex/availability";

import type { DesktopRuntimeAvailability } from "../shared/desktop-api.ts";

type RuntimeCheckResult = {
  readonly usable: boolean;
  readonly reason?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
};

type RuntimeChecker = () => Promise<RuntimeCheckResult>;

export async function getRuntimeAvailability(
  options: {
    readonly canUseCodexRuntime?: RuntimeChecker | undefined;
    readonly canUseClaudeCodeRuntime?: RuntimeChecker | undefined;
  } = {},
): Promise<DesktopRuntimeAvailability[]> {
  const [codex, claudeCode] = await Promise.all([
    (options.canUseCodexRuntime ?? canUseCodexRuntime)(),
    (options.canUseClaudeCodeRuntime ?? canUseClaudeCodeRuntime)(),
  ]);

  return [
    { id: "pi", status: "available" },
    toDesktopRuntimeAvailability("codex", codex),
    toDesktopRuntimeAvailability("claude-code", claudeCode),
  ];
}

function toDesktopRuntimeAvailability(
  id: "codex" | "claude-code",
  result: RuntimeCheckResult,
): DesktopRuntimeAvailability {
  const executablePath = stringDetail(result, "executablePath");
  const version = stringDetail(result, "version");

  return {
    id,
    status: result.usable ? "available" : "unavailable",
    ...(executablePath === undefined ? {} : { executablePath }),
    ...(version === undefined ? {} : { version }),
    ...(result.usable || result.reason === undefined ? {} : { reason: result.reason }),
  };
}

function stringDetail(result: RuntimeCheckResult, key: string): string | undefined {
  const value = result.details?.[key];
  return typeof value === "string" ? value : undefined;
}
