import { definePluginEntry, readExpertAgentPluginManifest } from "@pragma/core";
import type { ExpertAgentPluginSetupContext } from "@pragma/core";

import { prepareGitSessionEnvironment } from "./git.ts";
import type { RepoManagerConfigInput } from "./schema.ts";
import { parseRepoManagerConfig } from "./schema.ts";

export default definePluginEntry({
  manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
  setup: (context) => {
    const cleanupGitSessionEnvironments = new Map<string, () => Promise<void>>();
    const resolvedConfig = resolveConfig(context);

    return {
      hooks: {
        beforeSessionCreate: async (sessionContext) => {
          await cleanupGitSessionEnvironments.get(sessionContext.systemSessionId)?.();

          const prepared = await prepareGitSessionEnvironment(resolvedConfig, {
            env: sessionContext.processEnvironment,
            workspaceRoot: sessionContext.agent.workspace,
          });
          cleanupGitSessionEnvironments.set(sessionContext.systemSessionId, prepared.cleanup);
          sessionContext.logger?.info("Prepared Git session environment", {
            systemSessionId: sessionContext.systemSessionId,
            authStrategy: resolvedConfig.auth.strategy,
          });
          return { processEnvironment: prepared.processEnvironment };
        },
        afterSessionDestroy: async (sessionContext) => {
          await cleanupGitSessionEnvironments.get(sessionContext.session.systemSessionId)?.();
          cleanupGitSessionEnvironments.delete(sessionContext.session.systemSessionId);
          sessionContext.logger?.info("Cleaned up Git session environment", {
            systemSessionId: sessionContext.session.systemSessionId,
          });
        },
      },
    };
  },
});

function resolveConfig(
  context: ExpertAgentPluginSetupContext,
): ReturnType<typeof parseRepoManagerConfig> {
  const explicitConfig = readExplicitConfig(context.userConfig);
  return parseRepoManagerConfig(explicitConfig);
}

function readExplicitConfig(input: unknown): Partial<RepoManagerConfigInput> {
  if (input === undefined) {
    return {};
  }

  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Partial<RepoManagerConfigInput>;
  }

  throw new Error(
    `Repo Manager plugin config must be an object, received ${describeConfigInput(input)}.`,
  );
}

function describeConfigInput(input: unknown): string {
  if (input === null) {
    return "null";
  }

  if (Array.isArray(input)) {
    return "array";
  }

  return typeof input;
}
