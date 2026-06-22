import { describe, expect, it } from "vitest";

import { ExpertAgent, createInMemoryDocumentStore } from "@expertmesh/agent-core";
import { readExpertAgentPluginManifest } from "@expertmesh/agent-core";

import { CODE_REPOSITORY_DOCUMENT_ID } from "./document.ts";
import codeRepositoryManagerPlugin from "./plugin.ts";
import { parseCodeRepositoryManagerConfig } from "./schema.ts";

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
    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "repo-agent",
      displayName: "Repo Agent",
      description: "Test agent",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/expertmesh",
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
      installedPluginEntries: [codeRepositoryManagerPlugin],
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
    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "repo-agent",
      displayName: "Repo Agent",
      description: "Test agent",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace: "/tmp/expertmesh",
      installedPluginEntries: [codeRepositoryManagerPlugin],
    });

    await expect(agent.listDocuments()).resolves.toMatchObject({
      ok: true,
      value: [],
    });
  });

  it("exposes prepare and ensure repository tools", () => {
    const contributions = codeRepositoryManagerPlugin.setup({
      host: {},
      workspaceRoot: "/tmp/expertmesh",
      env: process.env,
    });

    expect(contributions.tools?.map((tool) => tool.name)).toEqual([
      "code_repository_manager_prepare_git",
      "code_repository_manager_ensure_repository",
    ]);
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
