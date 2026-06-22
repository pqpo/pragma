import { describe, expect, it } from "vitest";

import { ExpertAgent } from "../agent/expert-agent.ts";
import { createInMemoryDocumentStore } from "../documents/in-memory-document-store.ts";
import {
  events,
  extensibilityPlugin,
} from "./fixtures/extensibility-plugin/src/plugin.ts";
import { documentPlugin } from "./fixtures/document-plugin/src/plugin.ts";
import { createInvalidPlugin } from "./fixtures/invalid-plugin/src/plugin.ts";
import { createMissingManifestPlugin } from "./fixtures/missing-manifest-plugin/src/plugin.ts";
import { otherDocumentPlugin } from "./fixtures/other-document-plugin/src/plugin.ts";
import { dispatchExpertAgentHook } from "./expert-agent-plugin.ts";

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
    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "researcher",
      displayName: "Researcher",
      description: "Research expert",
      tags: ["research"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/expertmesh",
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
      plugins: [documentPlugin, otherDocumentPlugin],
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
    events.length = 0;

    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "researcher",
      displayName: "Researcher",
      description: "Research expert",
      tags: ["research"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/expertmesh",
      hooks: {
        beforeSessionCreate: () => {
          events.push("host");
        },
      },
      plugins: [extensibilityPlugin],
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

    expect(events).toEqual(["host", "plugin"]);
  });
});
