import { definePluginEntry } from "@expertmesh/agent-core";
import type {
  ExpertAgentContextItemMetadata,
  ExpertAgentContextStore,
  ExpertAgentPluginSetupContext,
} from "@expertmesh/agent-core";
import { HOST_CONTEXT_NAMESPACE, error, ok } from "@expertmesh/agent-core";

import {
  CODE_REPOSITORIES_SOURCE_CONTEXT_ID,
  CODE_REPOSITORY_CONTEXT_ID,
  createCodeRepositoryContextSeed,
} from "./context.ts";
import { prepareGitSessionEnvironment } from "./git.ts";
import type { CodeRepository } from "./schema.ts";
import {
  parseCodeRepositoryManagerConfig,
  parseCodeRepositoryManagerRepositoriesContext,
} from "./schema.ts";

const TOKEN_ENV = "EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_GIT_TOKEN";
const TOKEN_USERNAME_ENV = "EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_GIT_USERNAME";
const CREDENTIAL_HELPER_ENV = "EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_GIT_CREDENTIAL_HELPER";
const SSH_PRIVATE_KEY_ENV = "EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_SSH_PRIVATE_KEY";
const SSH_KNOWN_HOSTS_ENV = "EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_SSH_KNOWN_HOSTS";

const baseConfig = parseCodeRepositoryManagerConfig({});

export default definePluginEntry({
  setup: (context) => {
    const cleanupGitSessionEnvironments = new Map<string, () => Promise<void>>();
    context.contextSystem.register({
      namespace: "code-repository-manager",
      store: createCodeRepositoryContextStore(baseConfig, context),
    });

    return {
      hooks: {
        beforeSessionCreate: async (sessionContext) => {
          await cleanupGitSessionEnvironments.get(sessionContext.systemSessionId)?.();

          const resolvedConfig = await resolveConfig(baseConfig, context);
          const prepared = await prepareGitSessionEnvironment(resolvedConfig, {
            env: context.env,
          });
          cleanupGitSessionEnvironments.set(sessionContext.systemSessionId, prepared.cleanup);
        },
        afterSessionDestroy: async (sessionContext) => {
          await cleanupGitSessionEnvironments.get(sessionContext.session.systemSessionId)?.();
          cleanupGitSessionEnvironments.delete(sessionContext.session.systemSessionId);
        },
      },
    };
  },
});

function createCodeRepositoryContextStore(
  config: ReturnType<typeof parseCodeRepositoryManagerConfig>,
  context: ExpertAgentPluginSetupContext,
): ExpertAgentContextStore {
  return {
    async listContext() {
      const resolvedConfig = await resolveConfig(config, context);

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
      const resolvedConfig = await resolveConfig(config, context);

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
    async updateContext() {
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
  config: ReturnType<typeof parseCodeRepositoryManagerConfig>,
  context: ExpertAgentPluginSetupContext,
): Promise<ReturnType<typeof parseCodeRepositoryManagerConfig>> {
  const repositories = await readHostRepositories(context);

  return {
    ...config,
    auth: resolveAuth(context.env),
    repositories: repositories.length > 0 ? [...repositories] : config.repositories,
  };
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

  return parseCodeRepositoryManagerRepositoriesContext(JSON.parse(result.value.content));
}

function resolveAuth(
  env: NodeJS.ProcessEnv,
): ReturnType<typeof parseCodeRepositoryManagerConfig>["auth"] {
  if (readEnv(env, TOKEN_ENV) !== undefined) {
    return {
      strategy: "token",
      tokenEnv: TOKEN_ENV,
      username: readEnv(env, TOKEN_USERNAME_ENV) ?? "x-access-token",
    };
  }

  if (readEnv(env, CREDENTIAL_HELPER_ENV) !== undefined) {
    return {
      strategy: "credential_helper",
      helperEnv: CREDENTIAL_HELPER_ENV,
    };
  }

  if (readEnv(env, SSH_PRIVATE_KEY_ENV) !== undefined) {
    const knownHostsEnv =
      readEnv(env, SSH_KNOWN_HOSTS_ENV) === undefined ? {} : { knownHostsEnv: SSH_KNOWN_HOSTS_ENV };

    return {
      strategy: "ssh",
      privateKeyEnv: SSH_PRIVATE_KEY_ENV,
      ...knownHostsEnv,
    };
  }

  return { strategy: "none" };
}

function normalizeContextMetadata(
  metadata: Partial<ExpertAgentContextItemMetadata> | undefined,
): ExpertAgentContextItemMetadata {
  return {
    trigger: metadata?.trigger ?? "model_decision",
    ...(metadata?.description === undefined ? {} : { description: metadata.description }),
    ...(metadata?.trustLevel === undefined ? {} : { trustLevel: metadata.trustLevel }),
    ...(metadata?.sensitivity === undefined ? {} : { sensitivity: metadata.sensitivity }),
  };
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}
