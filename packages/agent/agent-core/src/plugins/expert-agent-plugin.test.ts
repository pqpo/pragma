import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ExpertAgent } from "../agent/expert-agent.ts";
import { createInMemoryDocumentStore } from "../documents/in-memory-document-store.ts";
import {
  extensibilityPlugin,
} from "./fixtures/extensibility-plugin/src/plugin.ts";
import { createInvalidPlugin } from "./fixtures/invalid-plugin/src/plugin.ts";
import { createMissingManifestPlugin } from "./fixtures/missing-manifest-plugin/src/plugin.ts";
import { dispatchExpertAgentHook } from "./expert-agent-plugin.ts";

const documentPluginPath = fileURLToPath(new URL("./fixtures/document-plugin", import.meta.url));
const extensibilityPluginPath = fileURLToPath(
  new URL("./fixtures/extensibility-plugin", import.meta.url),
);
const otherDocumentPluginPath = fileURLToPath(
  new URL("./fixtures/other-document-plugin", import.meta.url),
);
const tempWorkspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe("ExpertAgent plugins", () => {
  it("loads immutable plugin metadata and manifest fields from plugin.json", () => {
    expect(extensibilityPlugin).toMatchObject({
      id: "plugin.extensibility",
      name: "Extensibility",
      description: "Contributes every plugin surface",
      version: "0.0.0",
      tags: ["fixture", "extensibility"],
      manifest: {
        schemaVersion: "expertmesh.plugin/v1",
        capabilities: [
          {
            type: "managed-tool",
            name: "plugin_tool",
            description: "Plugin tool",
          },
        ],
        permissions: {
          network: ["models.example.test"],
        },
      },
    });
    expect(Object.isFrozen(extensibilityPlugin.manifest)).toBe(true);
    expect(Object.isFrozen(extensibilityPlugin.manifest.capabilities)).toBe(true);
  });

  it("rejects plugins without a plugin.json manifest", () => {
    expect(() => createMissingManifestPlugin()).toThrow(/plugin\.json was not found/);
  });

  it("rejects plugins with an invalid plugin.json manifest", () => {
    expect(() => createInvalidPlugin()).toThrow();
  });

  it("merges plugin documents with host documents", async () => {
    const workspace = await createPluginTestWorkspace();
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "researcher",
      displayName: "Researcher",
      description: "Research expert",
      tags: ["research"],
      version: "0.0.0",
      scope: "workspace",
      workspace,
      documents: createInMemoryDocumentStore({
        documents: [
          {
            id: "host.md",
            content: "Host content",
            metadata: {
              description: "Host doc",
              trigger: "always_on",
            },
          },
        ],
      }),
      plugins: [documentPluginPath, otherDocumentPluginPath],
    });

    await expect(agent.listDocuments()).resolves.toMatchObject({
      ok: true,
      value: [
        {
          id: "host.md",
          metadata: {
            description: "Host doc",
            trigger: "always_on",
          },
        },
        {
          id: "plugin.docs/plugin.md",
          metadata: {
            description: "Plugin doc",
            trigger: "model_decision",
          },
        },
        {
          id: "plugin.other-docs/plugin.md",
          metadata: {
            description: "Other plugin doc",
            trigger: "model_decision",
          },
        },
      ],
    });
    await expect(agent.readDocument({ id: "plugin.docs/plugin.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        id: "plugin.docs/plugin.md",
        content: "Plugin content",
      },
    });
    await expect(agent.readDocument({ id: "plugin.other-docs/plugin.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        id: "plugin.other-docs/plugin.md",
        content: "Other plugin content",
      },
    });
  });

  it("merges plugin mcp, skills, models, subagents, tools, and hooks", async () => {
    const hookEvents: string[] = [];
    const workspace = await createPluginTestWorkspace();
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "researcher",
      displayName: "Researcher",
      description: "Research expert",
      tags: ["research"],
      version: "0.0.0",
      scope: "workspace",
      workspace,
      hooks: {
        beforeSessionCreate: () => {
          hookEvents.push("host");
        },
      },
      plugins: [extensibilityPluginPath],
    });

    expect(agent.mcp?.mcpServers.pluginMcp?.name).toBe("Plugin MCP");
    expect(agent.skills?.skills.map((skill) => skill.name)).toEqual(["plugin-skill"]);
    expect(agent.models?.defaultModelName).toBe("plugin-model");
    expect(agent.models?.providers.map((provider) => provider.provider)).toEqual([
      "plugin-provider",
    ]);
    expect(agent.subAgents?.agents.map((subAgent) => subAgent.agentType)).toEqual(["critic"]);
    expect(agent.tools?.map((tool) => tool.name)).toEqual(["plugin_tool"]);

    await dispatchExpertAgentHook(agent.hooks, "beforeSessionCreate", {
      agent,
      context: {},
      systemSessionId: "system-session-1",
    });

    expect(agent.hooks?.beforeSessionCreate).toBeDefined();
    expect(hookEvents).toEqual(["host"]);
  });
});

async function createPluginTestWorkspace(): Promise<string> {
  const workspace = await mkdtemp(resolve(process.cwd(), ".expertmesh-plugin-test-"));
  tempWorkspaces.push(workspace);
  return workspace;
}
