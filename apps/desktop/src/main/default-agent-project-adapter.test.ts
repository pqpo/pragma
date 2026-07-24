import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  PRAGMA_AUTOMATION_PROMPT_MAX_LENGTH,
  PRAGMA_EXPERT_ID_MAX_LENGTH,
} from "@pragma/interpreter/ast";

import type { Capability } from "../shared/desktop-api.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";
import { createDesktopDefaultAgentProjectPort } from "./default-agent-project-adapter.ts";
import { createExpertDefinitionStore } from "./expert-definition-store.ts";
import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";
import type { CapabilityStore } from "./capability-store.ts";
import type { RuntimeEnvironmentService } from "./runtime-environment-service.ts";

describe("Desktop DefaultAgent DSL project adapter", () => {
  it("creates and updates the same exact ref through immutable project revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-project-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (await adapter.listExpertOptions()).runtimeModels[0]!.runtimeProfileRef;
    const first = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("First", runtimeRef)],
      }),
    );
    expect(first.diagnostics).toEqual([]);
    expect(first.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "expert:writer@1.0.0", kind: "created" }),
      ]),
    );
    await expect(
      adapter.commit({ changeSetId: first.changeSetId, operationId: "first" }),
    ).resolves.toMatchObject({ projectRevision: 1 });

    const second = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 1,
        sources: [expert("Second", runtimeRef)],
      }),
    );
    expect(second.changes).toMatchObject([{ ref: "expert:writer@1.0.0", kind: "updated" }]);
    const committed = await adapter.commit({
      changeSetId: second.changeSetId,
      operationId: "second",
    });
    expect(committed.projectRevision).toBe(2);
    expect((await adapter.read("expert:writer@1.0.0")).source).toContain("Second");
  });

  it("replays a committed operation idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-idempotent-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (await adapter.listExpertOptions()).runtimeModels[0]!.runtimeProfileRef;
    const candidate = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("One", runtimeRef)],
      }),
    );
    const first = await adapter.commit({ changeSetId: candidate.changeSetId, operationId: "same" });
    const second = await adapter.commit({
      changeSetId: candidate.changeSetId,
      operationId: "same",
    });
    expect(second).toEqual(first);
    expect((await project.get()).revision).toBe(1);
  });

  it("exposes only available models and ready capabilities through the portable port", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-options-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state"), [
        capability("00000000-0000-4000-8000-000000000001", "ready"),
        capability("00000000-0000-4000-8000-000000000002", "needs_attention"),
      ]),
    );

    const options = await adapter.listExpertOptions();

    expect(options.runtimeModels).toEqual([
      expect.objectContaining({
        runtimeName: "Test Runtime",
        providerName: "Test",
        modelName: "Test Model",
        isDefault: true,
      }),
    ]);
    expect(options.capabilities).toEqual([
      expect.objectContaining({
        name: "Repository access",
        kind: "skill",
        toolNames: [],
      }),
    ]);
  });

  it("creates a 50-character Expert that Desktop can list and open, and rejects 51", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-expert-id-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const experts = createExpertDefinitionStore({
      project,
      systemExperts: createDesktopSystemExpertRegistry(),
      validateModel: async () => undefined,
    });
    const runtimeRef = (await adapter.listExpertOptions()).runtimeModels[0]!.runtimeProfileRef;
    const acceptedId = "a".repeat(PRAGMA_EXPERT_ID_MAX_LENGTH);
    const candidate = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("Boundary", runtimeRef, acceptedId)],
      }),
    );

    await adapter.commit({ changeSetId: candidate.changeSetId, operationId: "boundary" });

    expect((await experts.list()).map((value) => value.id)).toContain(acceptedId);
    await expect(experts.get(`expert:${acceptedId}@1.0.0`)).resolves.toMatchObject({
      id: acceptedId,
      description: "Boundary",
    });
    await expect(
      adapter.prepare({
        expectedProjectRevision: 1,
        sources: [expert("Too long", runtimeRef, "a".repeat(PRAGMA_EXPERT_ID_MAX_LENGTH + 1))],
      }),
    ).resolves.toMatchObject({ status: "invalid" });
    expect((await project.get()).revision).toBe(1);
  });

  it("builds and atomically prepares a Flow through durable draft revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-flow-draft-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state"), [emptyDescriptionMcpCapability()]),
    );
    const description = "发布审批：验证非空 description";
    const created = await adapter.createFlowDraft({
      expectedProjectRevision: 0,
      metadata: {
        id: "release_gate",
        version: "1.0.0",
        name: "Release Gate",
        description,
        tags: [],
      },
    });
    expect(created.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "incomplete" })]),
    );
    const withStep = await adapter.updateFlowDraft({
      draftId: created.draftId,
      expectedDraftRevision: 0,
      operations: [
        {
          type: "upsert_step",
          stepId: "approve",
          step: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Release?" }] },
              options: [
                { value: "ship", label: "Ship" },
                { value: "hold", label: "Hold" },
              ],
            },
            version: "1.0.0",
          },
        },
      ],
    });
    expect(withStep.draftRevision).toBe(1);
    const complete = await adapter.updateFlowDraft({
      draftId: created.draftId,
      expectedDraftRevision: 1,
      operations: [
        { type: "set_start", stepId: "approve" },
        { type: "set_transition", stepId: "approve", transition: { end: true } },
      ],
    });
    expect(complete.diagnostics).toEqual([]);
    await expect(adapter.validateFlowDraft(created.draftId)).resolves.toMatchObject({
      resource: { metadata: { description } },
      diagnostics: [],
    });
    const prepared = requirePrepared(
      await adapter.prepareFlowDraft({
        draftId: created.draftId,
        expectedDraftRevision: 2,
      }),
    );
    expect(prepared.changes).toEqual([
      expect.objectContaining({
        ref: "flow:release_gate@1.0.0",
        kind: "created",
        source: expect.stringContaining(description),
      }),
    ]);
    const directlyPrepared = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [prepared.changes[0]!.source],
      }),
    );
    expect(directlyPrepared.changes).toEqual([
      expect.objectContaining({
        ref: "flow:release_gate@1.0.0",
        source: expect.stringContaining(description),
      }),
    ]);
    await adapter.commit({ changeSetId: prepared.changeSetId, operationId: "commit-flow-draft" });
    expect((await project.get()).resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "Flow",
          metadata: expect.objectContaining({ id: "release_gate" }),
        }),
      ]),
    );
  });

  it("returns structured prepare diagnostics for malformed YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-invalid-yaml-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    await expect(
      adapter.prepare({ expectedProjectRevision: 0, sources: ["kind: ["] }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "source.parse", source: "source:0" })],
    });
  });

  it("rejects over-limit Automation fields during prepare", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-automation-limit-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );

    await expect(
      adapter.prepare({
        expectedProjectRevision: 0,
        sources: [automationWithPrompt("p".repeat(PRAGMA_AUTOMATION_PROMPT_MAX_LENGTH + 1))],
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [
        expect.objectContaining({
          code: "schema.invalid",
          path: ["spec", "route", "input", "value"],
        }),
      ],
    });
    expect((await project.get()).revision).toBe(0);
  });
});

function requirePrepared<
  T extends Awaited<ReturnType<ReturnType<typeof createDesktopDefaultAgentProjectPort>["prepare"]>>,
>(result: T) {
  if (result.status !== "prepared") {
    throw new Error(`Expected prepared change-set: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.changeSet;
}

function expert(description: string, runtimeRef: string, id = "writer"): string {
  return [
    "apiVersion: pragma/v2",
    "kind: Expert",
    "metadata:",
    `  id: ${id}`,
    "  version: 1.0.0",
    "  name: Writer",
    `  description: ${description}`,
    "  tags: []",
    "spec:",
    "  scope: Write.",
    "  instructions: Write concise text.",
    "  runtime:",
    `    ref: ${runtimeRef}`,
    "  capabilities: []",
    "  toolApprovals: {}",
    "  contextStores: []",
    "  plugins: []",
    "  tools: []",
    "",
  ].join("\n");
}

function automationWithPrompt(prompt: string): string {
  return [
    "apiVersion: pragma/v2",
    "kind: Automation",
    "metadata:",
    "  id: daily_review",
    "  version: 1.0.0",
    "  name: Daily review",
    "  description: Reviews the current workspace",
    "  tags: []",
    "spec:",
    "  adapter: pragma.automation.schedule@v1",
    "  binding: binding:desktop-automation",
    "  config:",
    "    trigger:",
    "      kind: calendar",
    "      frequency: daily",
    "      time: 09:00",
    "      timezone: UTC",
    "  enabled: true",
    "  route:",
    "    executor:",
    "      ref: expert:reviewer@1.0.0",
    "    input:",
    "      kind: prompt",
    `      value: ${JSON.stringify(prompt)}`,
    "  interaction:",
    "    mode: reuse-session",
    "  delivery:",
    "    adapter: pragma.automation.delivery.local@v1",
    "",
  ].join("\n");
}

function adapterOptions(
  project: ReturnType<typeof createPragmaProjectStore>,
  stateRoot: string,
  values: readonly Capability[] = [],
) {
  const capabilities = { list: async () => values } as unknown as CapabilityStore;
  const runtimes = {
    getDefaultRuntimeId: async () => "test",
    list: async () => [
      {
        head: {
          entry: { runtimeId: "test" },
          revision: {
            revision: 1,
            status: "active",
            definition: {
              id: "test",
              displayName: "Test Runtime",
              origin: "built-in",
              adapter: { id: "test.adapter", version: "v1" },
              config: {},
            },
          },
        },
        adapter: {
          descriptor: { id: "test", kind: "test", displayName: "Test Runtime" },
          canUse: async () => ({ usable: true as const }),
          listModels: async () => [
            {
              id: "model",
              displayName: "Test Model",
              provider: { kind: "runtime-managed" as const, id: "test", displayName: "Test" },
              default: true,
            },
          ],
        },
      },
    ],
  } as unknown as RuntimeEnvironmentService;
  return { project, stateRoot, capabilities, runtimes };
}

function capability(id: string, status: "ready" | "needs_attention"): Capability {
  return {
    manifest: {
      schemaVersion: "pragma.capability/v1",
      id,
      runtimeKey: `repository_${id.at(-1)}`,
      name: "Repository access",
      kind: "skill",
      latestRevision: 1,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    },
    definition: {
      name: "Repository access",
      description: "Reads repository context.",
      kind: "skill",
      entryPath: "SKILL.md",
      contentHash: "a".repeat(64),
    },
    health: {
      revision: 1,
      status,
      checkedAt: "2026-07-19T00:00:00.000Z",
      ...(status === "needs_attention"
        ? { diagnostic: { code: "unavailable", message: "Unavailable", retryable: true } }
        : {}),
    },
  };
}

function emptyDescriptionMcpCapability(): Capability {
  return {
    manifest: {
      schemaVersion: "pragma.capability/v1",
      id: "00000000-0000-4000-8000-000000000003",
      runtimeKey: "empty_description_mcp",
      name: "Empty description MCP",
      kind: "mcp_server",
      latestRevision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    },
    definition: {
      name: "Empty description MCP",
      description: "",
      kind: "mcp_server",
      connection: {
        transport: "streamable-http",
        url: "https://example.com/mcp",
      },
      timeoutMs: 30_000,
      tools: [],
    },
    health: {
      revision: 1,
      status: "ready",
      checkedAt: "2026-07-24T00:00:00.000Z",
    },
  };
}
