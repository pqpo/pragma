import { canUseClaudeCodeRuntime } from "@pragma/runtime-claude-code/availability";
import { canUseCodexRuntime } from "@pragma/runtime-codex/availability";
import { createClaudeCodeModelDiscovery } from "@pragma/runtime-claude-code/models";
import { createCodexModelDiscovery } from "@pragma/runtime-codex/models";

import type { DesktopRuntimeAvailability } from "../shared/desktop-api.ts";

type RuntimeCheckResult = {
  readonly usable: boolean;
  readonly reason?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
};

type RuntimeChecker = () => Promise<RuntimeCheckResult>;
type ModelDiscovery = (executablePath?: string) => Promise<readonly RuntimeModelSummary[]>;

type RuntimeModelSummary = {
  readonly id: string;
  readonly displayName: string;
  readonly default?: boolean | undefined;
};

export async function getRuntimeAvailability(
  options: {
    readonly canUseCodexRuntime?: RuntimeChecker | undefined;
    readonly canUseClaudeCodeRuntime?: RuntimeChecker | undefined;
    readonly listCodexModels?: ModelDiscovery | undefined;
    readonly listClaudeCodeModels?: ModelDiscovery | undefined;
  } = {},
): Promise<DesktopRuntimeAvailability[]> {
  const [codex, claudeCode] = await Promise.all([
    (options.canUseCodexRuntime ?? canUseCodexRuntime)(),
    (options.canUseClaudeCodeRuntime ?? canUseClaudeCodeRuntime)(),
  ]);

  const runtimes: DesktopRuntimeAvailability[] = [
    { id: "pi", status: "available" },
    toDesktopRuntimeAvailability("codex", codex),
    toDesktopRuntimeAvailability("claude-code", claudeCode),
  ];

  await Promise.all(
    runtimes.map(async (runtime) => {
      if (runtime.id === "pi" || runtime.status !== "available") return;
      const listModels =
        runtime.id === "codex"
          ? (options.listCodexModels ?? defaultCodexModelDiscovery)
          : (options.listClaudeCodeModels ?? defaultClaudeCodeModelDiscovery);
      try {
        runtime.models = (await listModels(runtime.executablePath)).map((model) => ({
          id: model.id,
          displayName: model.displayName,
          ...(model.default === undefined ? {} : { default: model.default }),
        }));
      } catch (error) {
        runtime.modelDiscoveryError =
          error instanceof Error ? error.message : "Model discovery failed.";
      }
    }),
  );

  return runtimes;
}

async function defaultCodexModelDiscovery(
  executablePath?: string,
): Promise<readonly RuntimeModelSummary[]> {
  return await createCodexModelDiscovery({ executablePath })();
}

async function defaultClaudeCodeModelDiscovery(
  executablePath?: string,
): Promise<readonly RuntimeModelSummary[]> {
  return await createClaudeCodeModelDiscovery({ executablePath })();
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
