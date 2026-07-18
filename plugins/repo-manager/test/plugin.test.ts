import { describe, expect, it } from "vitest";

import { ContextSystem, createNoopLoggerProvider } from "@pragma/core";
import { readExpertAgentPluginManifest } from "@pragma/core";

import repoManagerPlugin from "../src/index.ts";
import { parseRepoManagerConfig, RepoManagerConfigSchema } from "../src/schema.ts";

describe("Repo Manager plugin", () => {
  it("reads Git-only plugin metadata from plugin.json at runtime", () => {
    const manifest = readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url));

    expect(repoManagerPlugin).toMatchObject({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      tags: manifest.tags,
    });
    expect(manifest.configuration).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        auth: expect.any(Object),
      },
    });
    expect(manifest.capabilities).toEqual([
      expect.objectContaining({
        type: "hook",
        name: "beforeSessionCreate",
      }),
    ]);
    expect(repoManagerPlugin.manifest).toEqual(manifest);
  });

  it("defaults to an isolated unauthenticated Git environment", () => {
    expect(parseRepoManagerConfig({})).toEqual({
      auth: { strategy: "none" },
    });
  });

  it("rejects removed repository and context-injection configuration", () => {
    expect(RepoManagerConfigSchema.safeParse({ repositories: [] }).success).toBe(false);
    expect(
      RepoManagerConfigSchema.safeParse({ contextInjection: { mode: "manual" } }).success,
    ).toBe(false);
  });

  it("prepares Git through session hooks without context or operation tools", () => {
    const contributions = repoManagerPlugin.setup({
      host: {},
      contextSystem: new ContextSystem(),
      workspaceRoot: "/tmp/pragma",
      userConfig: {},
      hostBindings: {},
      logger: createNoopLoggerProvider().createLogger({
        component: "plugin",
        pluginId: "plugin.repo-manager",
      }),
    });

    expect(contributions.tools).toBeUndefined();
    expect(contributions.hooks?.beforeSessionCreate).toBeDefined();
    expect(contributions.hooks?.afterSessionDestroy).toBeDefined();
  });
});
