import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ExpertAgent, createInMemoryDocumentStore } from "@expertmesh/agent-core";
import { readExpertAgentPluginManifest } from "@expertmesh/agent-core";

import { CODE_REPOSITORY_DOCUMENT_ID } from "./document.ts";
import codeRepositoryManagerPlugin from "./index.ts";
import { parseCodeRepositoryManagerConfig } from "./schema.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
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
    expect(codeRepositoryManagerPlugin.manifest).toEqual(manifest);
  });

  it("injects repository metadata as a model-decision document by default", async () => {
    const pluginSource = await createLoadablePluginSource();
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "repo-agent",
      displayName: "Repo Agent",
      description: "Test agent",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace: await createWorkspaceDir(),
      documents: createInMemoryDocumentStore({
        documents: [
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
      plugins: [pluginSource],
    });

    await expect(agent.listDocuments()).resolves.toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          id: `code-repository-manager/${CODE_REPOSITORY_DOCUMENT_ID}`,
          metadata: expect.objectContaining({
            trigger: "model_decision",
            trustLevel: "external",
            sensitivity: "internal",
          }),
        }),
      ]),
    });

    await expect(
      agent.readDocument({
        id: `code-repository-manager/${CODE_REPOSITORY_DOCUMENT_ID}`,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        content: expect.stringContaining('"id": "expert-mesh"'),
      },
    });
  });

  it("skips repository documents when repositories.json is not configured", async () => {
    const pluginSource = await createLoadablePluginSource();
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "repo-agent",
      displayName: "Repo Agent",
      description: "Test agent",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace: await createWorkspaceDir(),
      plugins: [pluginSource],
    });

    await expect(agent.listDocuments()).resolves.toMatchObject({
      ok: true,
      value: [],
    });
  });

  it("prepares Git through session hooks instead of exposing Git operation tools", () => {
    const contributions = codeRepositoryManagerPlugin.setup({
      host: {},
      workspaceRoot: "/tmp/expertmesh",
      env: process.env,
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

async function createLoadablePluginSource(): Promise<string> {
  const sourceDir = await createTempDir(repoRoot, "source");
  await cp(packageRoot, sourceDir, {
    recursive: true,
    filter: (source) =>
      !source.includes("/node_modules/") &&
      !source.includes("/dist/") &&
      !source.includes("/.turbo/"),
  });

  const manifestPath = resolve(sourceDir, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    runtime: {
      entry: string;
    };
  };
  manifest.runtime.entry = "./src/index.ts";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return sourceDir;
}

async function createWorkspaceDir(): Promise<string> {
  return await createTempDir(packageRoot, "workspace");
}

async function createTempDir(baseDir: string, kind: string): Promise<string> {
  const dir = await mkdtemp(resolve(baseDir, `.expertmesh-code-repository-${kind}-`));
  tempDirs.push(dir);
  return dir;
}
