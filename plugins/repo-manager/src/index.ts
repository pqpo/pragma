import { definePluginEntry, readExpertAgentPluginManifest } from "@pragma/core";
import type {
  ExpertAgentContextItemMetadata,
  ExpertAgentContextStore,
  ExpertAgentPluginSetupContext,
} from "@pragma/core";
import { HOST_CONTEXT_NAMESPACE, error, ok } from "@pragma/core";

import {
  CODE_REPOSITORIES_SOURCE_CONTEXT_ID,
  CODE_REPOSITORY_CONTEXT_ID,
  createCodeRepositoryContextSeed,
} from "./context.ts";
import { prepareGitSessionEnvironment } from "./git.ts";
import type { CodeRepository, RepoManagerConfigInput } from "./schema.ts";
import { parseRepoManagerConfig, parseRepoManagerRepositoriesContext } from "./schema.ts";

export default definePluginEntry({
  manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
  setup: (context) => {
    const cleanupGitSessionEnvironments = new Map<string, () => Promise<void>>();
    context.logger.info("Registering repo manager context store", {
      namespace: "repo-manager",
    });
    context.contextSystem.register({
      namespace: "repo-manager",
      store: createCodeRepositoryContextStore(context),
    });

    return {
      hooks: {
        beforeSessionCreate: async (sessionContext) => {
          await cleanupGitSessionEnvironments.get(sessionContext.systemSessionId)?.();

          const resolvedConfig = await resolveConfig(context);
          const prepared = await prepareGitSessionEnvironment(resolvedConfig, {
            env: context.env,
          });
          cleanupGitSessionEnvironments.set(sessionContext.systemSessionId, prepared.cleanup);
          sessionContext.logger?.info("Prepared code repository git session environment", {
            systemSessionId: sessionContext.systemSessionId,
            authStrategy: resolvedConfig.auth.strategy,
          });
        },
        afterSessionDestroy: async (sessionContext) => {
          await cleanupGitSessionEnvironments.get(sessionContext.session.systemSessionId)?.();
          cleanupGitSessionEnvironments.delete(sessionContext.session.systemSessionId);
          sessionContext.logger?.info("Cleaned up code repository git session environment", {
            systemSessionId: sessionContext.session.systemSessionId,
          });
        },
      },
    };
  },
});

function createCodeRepositoryContextStore(
  context: ExpertAgentPluginSetupContext,
): ExpertAgentContextStore {
  return {
    async listContext() {
      const resolvedConfig = await resolveConfig(context);

      if (resolvedConfig.repositories.length === 0) {
        return ok([]);
      }

      const seed = createCodeRepositoryContextSeed(resolvedConfig);

      return ok([
        {
          id: seed.id,
          metadata: normalizeContextMetadata(seed.metadata),
          sizeBytes: Buffer.byteLength(seed.content, "utf8"),
        },
      ]);
    },
    async readContext(input) {
      const resolvedConfig = await resolveConfig(context);

      if (resolvedConfig.repositories.length === 0) {
        return error("context_not_found", "Code repository context is not configured.");
      }

      const seed = createCodeRepositoryContextSeed(resolvedConfig);

      if (input.id !== seed.id) {
        return error("context_not_found", `Context not found: ${input.id}`);
      }

      return ok({
        id: seed.id,
        content: seed.content,
        metadata: normalizeContextMetadata(seed.metadata),
        contentRange: {
          requestedStartOffset: 0,
          startOffset: 0,
          endOffset: seed.content.length,
          nextStartOffset: seed.content.length,
          truncated: false,
          sizeBytes: Buffer.byteLength(seed.content, "utf8"),
        },
        sizeBytes: Buffer.byteLength(seed.content, "utf8"),
      });
    },
    async addContext() {
      return error("permission_denied", "Code repository plugin context is read-only.");
    },
    async editContext() {
      return error("permission_denied", "Code repository plugin context is read-only.");
    },
    async deleteContext() {
      return error("permission_denied", "Code repository plugin context is read-only.");
    },
    async searchContext(input) {
      const context = await this.readContext({
        id: CODE_REPOSITORY_CONTEXT_ID,
        context: input.context,
      });

      if (!context.ok) {
        return ok([]);
      }

      return ok(
        context.value.content
          .split("\n")
          .map((line, index) => ({ line, lineNumber: index + 1 }))
          .filter((line) => line.line.includes(input.query))
          .slice(0, input.maxResults ?? 20)
          .map((match) => ({
            id: CODE_REPOSITORY_CONTEXT_ID,
            lineNumber: match.lineNumber,
            line: match.line,
          })),
      );
    },
  };
}

async function resolveConfig(
  context: ExpertAgentPluginSetupContext,
): Promise<ReturnType<typeof parseRepoManagerConfig>> {
  const explicitConfig = readExplicitConfig(context.userConfig);
  const repositories = await readHostRepositories(context);
  const parsedConfig = parseRepoManagerConfig({
    ...explicitConfig,
    auth: explicitConfig.auth,
  });

  return {
    ...parsedConfig,
    repositories:
      explicitConfig.repositories !== undefined
        ? parsedConfig.repositories
        : repositories.length > 0
          ? [...repositories]
          : parsedConfig.repositories,
  };
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

async function readHostRepositories(
  context: ExpertAgentPluginSetupContext,
): Promise<readonly CodeRepository[]> {
  const result = await context.contextSystem.read({
    namespace: HOST_CONTEXT_NAMESPACE,
    id: CODE_REPOSITORIES_SOURCE_CONTEXT_ID,
  });

  if (!result.ok) {
    return [];
  }

  return parseRepoManagerRepositoriesContext(JSON.parse(result.value.content));
}

function normalizeContextMetadata(
  metadata: Partial<ExpertAgentContextItemMetadata> | undefined,
): ExpertAgentContextItemMetadata {
  return {
    trigger: metadata?.trigger ?? "manual",
    ...(metadata?.description === undefined ? {} : { description: metadata.description }),
    ...(metadata?.trustLevel === undefined ? {} : { trustLevel: metadata.trustLevel }),
    ...(metadata?.sensitivity === undefined ? {} : { sensitivity: metadata.sensitivity }),
    priority: metadata?.priority ?? "normal",
  };
}
