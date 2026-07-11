import { describe, expect, it } from "vitest";

import type { Capability, ExpertDefinition } from "../shared/desktop-api.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { resolveExpertCapabilities } from "./desktop-expert-factory.ts";

const skillId = "7abfdc9a-a5e2-4be2-a7bb-a11f8e5fbb17";
const serviceId = "77af9336-0d2f-435d-a53c-d65077db75ba";

const skill: Capability = {
  manifest: {
    schemaVersion: "pragma.capability/v1",
    id: skillId,
    runtimeKey: "repo_review_7abfdc9a",
    name: "Repo Review",
    kind: "skill",
    latestRevision: 1,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  },
  health: { revision: 1, status: "ready", checkedAt: "2026-07-11T00:00:00.000Z" },
  definition: {
    kind: "skill",
    name: "repo-review",
    description: "Review a repository.",
    entryPath: "SKILL.md",
    contentHash: "a".repeat(64),
  },
};

const service: Capability = {
  manifest: {
    schemaVersion: "pragma.capability/v1",
    id: serviceId,
    runtimeKey: "customer_api_77af9336",
    name: "Customer API",
    kind: "http_service",
    latestRevision: 1,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  },
  health: { revision: 1, status: "ready", checkedAt: "2026-07-11T00:00:00.000Z" },
  definition: {
    kind: "http_service",
    name: "Customer API",
    description: "Customer records.",
    baseUrl: "https://api.example.test",
    auth: { type: "bearer", credentialRef: "service-auth" },
    timeoutMs: 30_000,
    tools: [
      {
        name: "get_customer",
        description: "Get a customer.",
        method: "GET",
        path: "/customers/{id}",
        parameters: [{ name: "id", location: "path", required: true, type: "string" }],
      },
    ],
  },
};

describe("resolveExpertCapabilities", () => {
  it("materializes pinned Skills and selected HTTP tools", async () => {
    const capabilities = new Map([
      [skillId, skill],
      [serviceId, service],
    ]);
    const store = {
      get: async (id: string) => capabilities.get(id) as Capability,
    } as CapabilityStore;
    const credentials = {
      get: async (_id: string, name: string) => (name === "service-auth" ? "secret" : undefined),
    } as CapabilityCredentialStore;
    const expert: ExpertDefinition = {
      schemaVersion: "pragma.expert/v2",
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews work.",
      tags: [],
      version: "1.0.0",
      scope: "Review only.",
      model: null,
      capabilities: [
        { kind: "skill", capabilityId: skillId, revision: 1 },
        { kind: "tools", capabilityId: serviceId, revision: 1, toolNames: ["get_customer"] },
      ],
      toolApprovals: {},
      plugins: [],
      contextStoreMounts: [],
      revision: 1,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    };

    const resolved = await resolveExpertCapabilities({
      expert,
      store,
      credentials,
      capabilitiesPath: "/home/user/.pragma/capabilities",
    });

    expect(resolved.skills?.skills[0]?.path).toContain(
      `${skillId}/revisions/000001/payload/SKILL.md`,
    );
    const mcpServer = resolved.mcp?.mcpServers[service.manifest.runtimeKey];
    expect(mcpServer?.transport).toBe("in-process");
    if (mcpServer?.transport !== "in-process") throw new Error("Expected in-process MCP server.");
    await expect(mcpServer.inProcess.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "get_customer" }),
    ]);
    expect(mcpServer.toolApprovals?.["get_customer"]?.mode).toBe("ask");
  });
});
