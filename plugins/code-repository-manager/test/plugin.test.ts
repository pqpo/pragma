import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextSystem,
  ExpertAgent,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
  createNoopLoggerProvider,
} from "@pragma/core";
import { readExpertAgentPluginManifest } from "@pragma/core";
import type { ExpertAgentPluginUse } from "@pragma/core";

import { CODE_REPOSITORY_CONTEXT_ID } from "../src/context.ts";
import codeRepositoryManagerPlugin from "../src/index.ts";
import { parseCodeRepositoryManagerConfig } from "../src/schema.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Code Repository Manager plugin", () => {
  it("reads plugin metadata from plugin.json at runtime", () => {
    const manifest = readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url));

    expect(codeRepositoryManagerPlugin).toMatchObject({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      tags: manifest.tags,
    });
    expect(manifest.configuration.properties.map((property) => property.name)).toEqual([
      "contextInjection.mode",
      "repositories",
      "auth.strategy",
      "auth.token",
      "auth.tokenEnv",
      "auth.username",
      "auth.privateKey",
      "auth.privateKeyEnv",
      "auth.knownHosts",
      "auth.knownHostsEnv",
      "auth.helper",
      "auth.helperEnv",
    ]);
    expect(codeRepositoryManagerPlugin.manifest).toEqual(manifest);
  });

  it("injects repository metadata as a model-decision context by default", async () => {
    const pluginSource = await createLoadablePluginSource();
    const contextSystem = new ContextSystem();
    contextSystem.register({
      namespace: HOST_CONTEXT_NAMESPACE,
      store: createInMemoryContextStore({
        context: [
          {
            id: "repositories.json",
            content: JSON.stringify({
              repositories: [
                {
                  id: "expert-mesh",
                  name: "ExpertMesh",
                  cloneUrl: "https://github.com/example/expert-mesh.git",
                  defaultBranch: "main",
                },
              ],
            }),
            metadata: {
              trigger: "manual",
            },
          },
        ],
      }),
    });
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "repo-agent",
      name: "Repo Agent",
      description: "Test agent",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace: await createWorkspaceDir(),
      contextSystem,
      plugins: [pluginSource],
    });

    await expect(agent.listContext()).resolves.toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          namespace: "code-repository-manager",
          id: CODE_REPOSITORY_CONTEXT_ID,
          metadata: expect.objectContaining({
            trigger: "model_decision",
            trustLevel: "external",
            sensitivity: "internal",
          }),
        }),
      ]),
    });

    await expect(
      agent.readContext({
        namespace: "code-repository-manager",
        id: CODE_REPOSITORY_CONTEXT_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        content: expect.stringContaining('"id": "expert-mesh"'),
      },
    });
  });

  it("skips repository context when repositories.json is not configured", async () => {
    const pluginSource = await createLoadablePluginSource();
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "repo-agent",
      name: "Repo Agent",
      description: "Test agent",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace: await createWorkspaceDir(),
      plugins: [pluginSource],
    });

    await expect(agent.listContext()).resolves.toMatchObject({
      ok: true,
      value: [],
    });
  });

  it("injects repository metadata from source dependency plugin config", async () => {
    const agent = await createAgent({
      workspace: await createWorkspaceDir(),
      plugins: [
        {
          entry: codeRepositoryManagerPlugin,
          config: {
            repositories: [
              {
                id: "configured-repo",
                name: "Configured Repo",
                cloneUrl: "https://github.com/example/configured-repo.git",
                defaultBranch: "main",
              },
            ],
          },
        },
      ],
    });

    await expect(
      agent.readContext({
        namespace: "code-repository-manager",
        id: CODE_REPOSITORY_CONTEXT_ID,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        content: expect.stringContaining('"id": "configured-repo"'),
      },
    });
  });

  it("prepares Git through session hooks instead of exposing Git operation tools", () => {
    const contributions = codeRepositoryManagerPlugin.setup({
      host: {},
      contextSystem: new ContextSystem(),
      workspaceRoot: "/tmp/expertmesh",
      env: process.env,
      logger: createNoopLoggerProvider().createLogger({
        component: "plugin",
        pluginId: "plugin.code-repository-manager",
      }),
    });

    expect(contributions.tools).toBeUndefined();
    expect(contributions.hooks?.beforeSessionCreate).toBeDefined();
    expect(contributions.hooks?.afterSessionDestroy).toBeDefined();
  });

  it("rejects repository clone URLs and branch names that could be interpreted as Git options", () => {
    expect(() =>
      parseCodeRepositoryManagerConfig({
        repositories: [
          {
            id: "repo",
            name: "Repo",
            cloneUrl: "--upload-pack=echo injected",
            defaultBranch: "main",
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      parseCodeRepositoryManagerConfig({
        repositories: [
          {
            id: "repo",
            name: "Repo",
            cloneUrl: "https://github.com/example/repo.git",
            defaultBranch: "--orphan",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects clone URLs with embedded credentials", () => {
    expect(() =>
      parseCodeRepositoryManagerConfig({
        repositories: [
          {
            id: "repo",
            name: "Repo",
            cloneUrl: "https://token@github.com/example/repo.git",
            defaultBranch: "main",
          },
        ],
      }),
    ).toThrow();
  });
});

async function createAgent(options: {
  readonly workspace: string;
  readonly plugins: readonly ExpertAgentPluginUse[];
  readonly contextSystem?: ContextSystem | undefined;
}): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    schemaVersion: "expertmesh.expert/v1",
    id: "repo-agent",
    name: "Repo Agent",
    description: "Test agent",
    tags: ["test"],
    version: "0.0.0",
    scope: "test",
    workspace: options.workspace,
    ...(options.contextSystem === undefined ? {} : { contextSystem: options.contextSystem }),
    plugins: options.plugins,
  });
}

async function createLoadablePluginSource(): Promise<ExpertAgentPluginUse> {
  return { entry: codeRepositoryManagerPlugin };
}

async function createWorkspaceDir(): Promise<string> {
  return await createTempDir(packageRoot, "workspace");
}

async function createTempDir(baseDir: string, kind: string): Promise<string> {
  const dir = await mkdtemp(resolve(baseDir, `.expertmesh-code-repository-${kind}-`));
  tempDirs.push(dir);
  return dir;
}
