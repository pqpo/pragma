import { createExpertAgentPluginConfigEnvName, definePluginEntry } from "@expertmesh/agent-core";
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
import type { CodeRepository, CodeRepositoryManagerConfigInput } from "./schema.ts";
import {
  parseCodeRepositoryManagerConfig,
  parseCodeRepositoryManagerRepositoriesContext,
} from "./schema.ts";

const PLUGIN_ID = "code-repository-manager";
const TOKEN_ENV = createPluginEnvName("auth.token");
const TOKEN_USERNAME_ENV = createPluginEnvName("auth.username");
const CREDENTIAL_HELPER_ENV = createPluginEnvName("auth.helper");
const SSH_PRIVATE_KEY_ENV = createPluginEnvName("auth.privateKey");
const SSH_KNOWN_HOSTS_ENV = createPluginEnvName("auth.knownHosts");

export default definePluginEntry({
  setup: (context) => {
    const cleanupGitSessionEnvironments = new Map<string, () => Promise<void>>();
    context.contextSystem.register({
      namespace: "code-repository-manager",
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
  context: ExpertAgentPluginSetupContext,
): Promise<ReturnType<typeof parseCodeRepositoryManagerConfig>> {
  const explicitConfig = readExplicitConfig(context.config);
  const repositories = await readHostRepositories(context);
  const parsedConfig = parseCodeRepositoryManagerConfig({
    ...explicitConfig,
    auth: explicitConfig.auth ?? resolveAuth(context.env),
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

function readExplicitConfig(input: unknown): Partial<CodeRepositoryManagerConfigInput> {
  if (input === undefined) {
    return {};
  }

  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Partial<CodeRepositoryManagerConfigInput>;
  }

  throw new Error(
    `Code Repository Manager plugin config must be an object, received ${describeConfigInput(input)}.`,
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

  return parseCodeRepositoryManagerRepositoriesContext(JSON.parse(result.value.content));
}

function resolveAuth(
  env: NodeJS.ProcessEnv,
): ReturnType<typeof parseCodeRepositoryManagerConfig>["auth"] {
  const token = readEnv(env, TOKEN_ENV);

  if (token !== undefined) {
    return {
      strategy: "token",
      token,
      username: readEnv(env, TOKEN_USERNAME_ENV) ?? "x-access-token",
    };
  }

  const helper = readEnv(env, CREDENTIAL_HELPER_ENV);

  if (helper !== undefined) {
    return {
      strategy: "credential_helper",
      helper,
    };
  }

  const privateKey = readEnv(env, SSH_PRIVATE_KEY_ENV);

  if (privateKey !== undefined) {
    const knownHosts = readEnv(env, SSH_KNOWN_HOSTS_ENV);

    return {
      strategy: "ssh",
      privateKey,
      ...(knownHosts === undefined ? {} : { knownHosts }),
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

function createPluginEnvName(name: string): string {
  return createExpertAgentPluginConfigEnvName({
    pluginId: PLUGIN_ID,
    name,
  });
}
