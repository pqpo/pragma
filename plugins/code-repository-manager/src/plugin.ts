import { definePluginEntry } from "@expertmesh/agent-core";
import type {
  ExpertAgentManagedTool,
  ExpertAgentPluginEntry,
  ExpertAgentToolCallResult,
} from "@expertmesh/agent-core";

import { createCodeRepositoryDocumentSeed } from "./document.ts";
import { ensureRepository, prepareGitEnvironment } from "./git.ts";
import type { CodeRepositoryManagerConfigInput } from "./schema.ts";
import { parseCodeRepositoryManagerConfig } from "./schema.ts";

export interface CreateCodeRepositoryManagerPluginOptions {
  readonly workspaceRoot: string;
  readonly gitCommand?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly prepareOnSessionCreate?: boolean | undefined;
}

export function createCodeRepositoryManagerPlugin(
  input: CodeRepositoryManagerConfigInput,
  options: CreateCodeRepositoryManagerPluginOptions,
): ExpertAgentPluginEntry {
  const config = parseCodeRepositoryManagerConfig(input);
  const gitOptions = {
    gitCommand: options.gitCommand,
    env: options.env,
  };

  return definePluginEntry({
    setup: () => ({
      documents: [createCodeRepositoryDocumentSeed(config)],
      tools: createCodeRepositoryTools(config, options),
      hooks:
        options.prepareOnSessionCreate === true
          ? {
              beforeSessionCreate: async () => {
                await prepareGitEnvironment(config, gitOptions);
              },
            }
          : undefined,
    }),
  });
}

function createCodeRepositoryTools(
  config: ReturnType<typeof parseCodeRepositoryManagerConfig>,
  options: CreateCodeRepositoryManagerPluginOptions,
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
        const result = await prepareGitEnvironment(config, {
          gitCommand: options.gitCommand,
          env: options.env,
          signal,
        });

        return {
          text: [
            "Git repository manager is ready.",
            `Git: ${result.gitVersion}`,
            `Auth strategy: ${result.authStrategy}`,
            `Repositories: ${result.repositoryCount}`,
          ].join("\n"),
          details: result,
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
        const result = await ensureRepository(config, {
          repoId,
          workspaceRoot: options.workspaceRoot,
          gitCommand: options.gitCommand,
          env: options.env,
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
