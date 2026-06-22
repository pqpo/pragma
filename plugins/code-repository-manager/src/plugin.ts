import { definePluginEntry } from "@expertmesh/agent-core";
import type {
  ExpertAgentDocumentMetadata,
  ExpertAgentDocumentStore,
  ExpertAgentManagedTool,
  ExpertAgentPluginSetupContext,
  ExpertAgentToolCallResult,
} from "@expertmesh/agent-core";
import { error, ok } from "@expertmesh/agent-core";

import {
  CODE_REPOSITORIES_SOURCE_DOCUMENT_ID,
  CODE_REPOSITORY_DOCUMENT_ID,
  createCodeRepositoryDocumentSeed,
} from "./document.ts";
import { ensureRepository, prepareGitEnvironment } from "./git.ts";
import type { CodeRepository } from "./schema.ts";
import {
  parseCodeRepositoryManagerConfig,
  parseCodeRepositoryManagerRepositoriesDocument,
} from "./schema.ts";

const TOKEN_ENV = "EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_GIT_TOKEN";
const TOKEN_USERNAME_ENV = "EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_GIT_USERNAME";
const SSH_PRIVATE_KEY_ENV = "EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_SSH_PRIVATE_KEY";
const SSH_KNOWN_HOSTS_ENV = "EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_SSH_KNOWN_HOSTS";

const baseConfig = parseCodeRepositoryManagerConfig({});

export default definePluginEntry({
  setup: (context) => ({
    documents: createCodeRepositoryDocumentStore(baseConfig, context),
    tools: createCodeRepositoryTools(baseConfig, context),
  }),
});

function createCodeRepositoryTools(
  config: ReturnType<typeof parseCodeRepositoryManagerConfig>,
  context: ExpertAgentPluginSetupContext,
): readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] {
  return [
    {
      name: "code_repository_manager_prepare_git",
      description:
        "Check that Git CLI and configured repository credentials are available before repository operations.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      call: async (_args, signal) => {
        const resolvedConfig = await resolveConfig(config, context);
        const result = await prepareGitEnvironment(resolvedConfig, {
          env: context.env,
          signal,
        });

        return {
          text: [
            "Git repository manager is ready.",
            `Git: ${result.gitVersion}`,
            `Auth strategy: ${result.authStrategy}`,
            `Repositories: ${resolvedConfig.repositories.length}`,
          ].join("\n"),
          details: {
            ...result,
            repositoryCount: resolvedConfig.repositories.length,
          },
        };
      },
    },
    {
      name: "code_repository_manager_ensure_repository",
      description:
        "Clone a configured repository into the Agent workspace, or fetch it if it already exists.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["repoId"],
        properties: {
          repoId: {
            type: "string",
            description: "Repository id from the code-repositories.md document.",
          },
        },
      },
      call: async (args, signal) => {
        const repoId = readRepoIdArg(args);
        const resolvedConfig = await resolveConfig(config, context);
        assertRepositoriesConfigured(resolvedConfig.repositories);
        const result = await ensureRepository(resolvedConfig, {
          repoId,
          workspaceRoot: context.workspaceRoot,
          env: context.env,
          signal,
        });

        return {
          text: [
            `Repository ${result.repoId} ${result.action}.`,
            `Path: ${result.path}`,
            `Branch: ${result.branch}`,
          ].join("\n"),
          details: result,
        };
      },
    },
  ];
}

function createCodeRepositoryDocumentStore(
  config: ReturnType<typeof parseCodeRepositoryManagerConfig>,
  context: ExpertAgentPluginSetupContext,
): ExpertAgentDocumentStore {
  return {
    async listDocuments() {
      const resolvedConfig = await resolveConfig(config, context);

      if (resolvedConfig.repositories.length === 0) {
        return ok([]);
      }

      const seed = createCodeRepositoryDocumentSeed(resolvedConfig);

      return ok([
        {
          id: seed.id,
          metadata: createDocumentMetadata(seed.metadata),
          sizeBytes: Buffer.byteLength(seed.content, "utf8"),
        },
      ]);
    },
    async readDocument(input) {
      const resolvedConfig = await resolveConfig(config, context);

      if (resolvedConfig.repositories.length === 0) {
        return error("document_not_found", "Code repository document is not configured.");
      }

      const seed = createCodeRepositoryDocumentSeed(resolvedConfig);

      if (input.id !== seed.id) {
        return error("document_not_found", `Document not found: ${input.id}`);
      }

      return ok({
        id: seed.id,
        content: seed.content,
        metadata: createDocumentMetadata(seed.metadata),
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
    async createDocument() {
      return error("permission_denied", "Code repository plugin documents are read-only.");
    },
    async updateDocument() {
      return error("permission_denied", "Code repository plugin documents are read-only.");
    },
    async deleteDocument() {
      return error("permission_denied", "Code repository plugin documents are read-only.");
    },
    async searchDocuments(input) {
      const document = await this.readDocument({
        id: CODE_REPOSITORY_DOCUMENT_ID,
        context: input.context,
      });

      if (!document.ok) {
        return ok([]);
      }

      return ok(
        document.value.content
          .split("\n")
          .map((line, index) => ({ line, lineNumber: index + 1 }))
          .filter((line) => line.line.includes(input.query))
          .slice(0, input.maxResults ?? 20)
          .map((match) => ({
            id: CODE_REPOSITORY_DOCUMENT_ID,
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
  const result = await context.hostDocuments?.readDocument({
    id: CODE_REPOSITORIES_SOURCE_DOCUMENT_ID,
  });

  if (result === undefined || !result.ok) {
    return [];
  }

  return parseCodeRepositoryManagerRepositoriesDocument(JSON.parse(result.value.content));
}

function resolveAuth(env: NodeJS.ProcessEnv): ReturnType<typeof parseCodeRepositoryManagerConfig>["auth"] {
  if (readEnv(env, TOKEN_ENV) !== undefined) {
    return {
      strategy: "token",
      tokenEnv: TOKEN_ENV,
      username: readEnv(env, TOKEN_USERNAME_ENV) ?? "x-access-token",
    };
  }

  if (readEnv(env, SSH_PRIVATE_KEY_ENV) !== undefined) {
    const knownHostsEnv = readEnv(env, SSH_KNOWN_HOSTS_ENV) === undefined
      ? {}
      : { knownHostsEnv: SSH_KNOWN_HOSTS_ENV };

    return {
      strategy: "ssh",
      privateKeyEnv: SSH_PRIVATE_KEY_ENV,
      ...knownHostsEnv,
    };
  }

  return { strategy: "none" };
}

function createDocumentMetadata(
  metadata: Partial<ExpertAgentDocumentMetadata> | undefined,
): ExpertAgentDocumentMetadata {
  return {
    trigger: metadata?.trigger ?? "model_decision",
    ...(metadata?.description === undefined ? {} : { description: metadata.description }),
    ...(metadata?.trustLevel === undefined ? {} : { trustLevel: metadata.trustLevel }),
    ...(metadata?.sensitivity === undefined ? {} : { sensitivity: metadata.sensitivity }),
  };
}

function assertRepositoriesConfigured(repositories: readonly CodeRepository[]): void {
  if (repositories.length === 0) {
    throw new Error(
      `No code repositories configured. Add ${CODE_REPOSITORIES_SOURCE_DOCUMENT_ID} to the host Agent documents.`,
    );
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function readRepoIdArg(args: unknown): string {
  if (typeof args !== "object" || args === null || !("repoId" in args)) {
    throw new Error("repoId is required.");
  }

  const repoId = (args as { readonly repoId?: unknown }).repoId;

  if (typeof repoId !== "string" || repoId.trim().length === 0) {
    throw new Error("repoId must be a non-empty string.");
  }

  return repoId.trim();
}
