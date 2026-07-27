import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  PRAGMA_AUTOMATION_PROMPT_MAX_LENGTH,
  PragmaFlowResourceSchema,
} from "@pragma/interpreter/ast";

import type { Capability } from "../../../shared/contracts/index.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createDesktopDefaultAgentProjectPort } from "./default-agent-project-adapter.ts";
import { createExpertDefinitionStore } from "../experts/expert-definition-store.ts";
import { createDesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { RuntimeEnvironmentService } from "../runtimes/runtime-environment-service.ts";

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
        expect.objectContaining({ ref: "expert:1xddvess309a6gme", kind: "created" }),
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
    expect(second.changes).toMatchObject([{ ref: "expert:1xddvess309a6gme", kind: "updated" }]);
    const committed = await adapter.commit({
      changeSetId: second.changeSetId,
      operationId: "second",
    });
    expect(committed.projectRevision).toBe(2);
    expect((await adapter.read("expert:1xddvess309a6gme")).source).toContain("Second");
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

  it("creates a 16-character Expert that Desktop can list and open, and rejects 17", async () => {
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
    const acceptedId = "a".repeat(16);
    const candidate = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("Boundary", runtimeRef, acceptedId)],
      }),
    );

    await adapter.commit({ changeSetId: candidate.changeSetId, operationId: "boundary" });

    expect((await experts.list()).map((value) => value.id)).toContain(acceptedId);
    await expect(experts.get(`expert:${acceptedId}`)).resolves.toMatchObject({
      id: acceptedId,
      description: "Boundary",
    });
    await expect(
      adapter.prepare({
        expectedProjectRevision: 1,
        sources: [expert("Too long", runtimeRef, "a".repeat(17))],
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
          },
        },
      ],
    });
    expect(withStep.draftRevision).toBe(1);
    const graphComplete = await adapter.updateFlowDraft({
      draftId: created.draftId,
      expectedDraftRevision: 1,
      operations: [
        { type: "set_start", stepId: "approve" },
        { type: "set_transition", stepId: "approve", transition: { end: true } },
      ],
    });
    expect(graphComplete.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "incomplete",
          code: "flow.run_dry.cases_missing",
        }),
      ]),
    );
    const complete = await adapter.updateFlowDraft({
      draftId: created.draftId,
      expectedDraftRevision: 2,
      operations: [
        {
          type: "set_run_dry",
          runDry: {
            cases: [
              {
                id: "ship",
                name: "Ship release",
                input: {},
                mocks: {
                  approve: {
                    expectInput: {},
                    expectPrompt: "Release?",
                    output: { selection: "ship" },
                  },
                },
                expect: {
                  status: "succeeded",
                  path: ["approve"],
                  output: { selection: "ship" },
                },
              },
            ],
          },
        },
      ],
    });
    expect(complete.diagnostics).toEqual([]);
    await expect(adapter.runFlowDraftDry(created.draftId)).resolves.toMatchObject({
      passed: true,
      summary: { total: 1, passed: 1, failed: 0 },
      coverage: { missing: [] },
    });
    await expect(adapter.validateFlowDraft(created.draftId)).resolves.toMatchObject({
      resource: { metadata: { description } },
      diagnostics: [],
    });
    const prepared = requirePrepared(
      await adapter.prepareFlowDraft({
        draftId: created.draftId,
        expectedDraftRevision: 3,
      }),
    );
    expect(prepared.changes).toEqual([
      expect.objectContaining({
        ref: expect.stringMatching(/^flow:[0-9a-hjkmnp-tv-z]{16}$/),
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
        ref: prepared.changes[0]!.ref,
        source: expect.stringContaining(description),
      }),
    ]);
    await adapter.commit({ changeSetId: prepared.changeSetId, operationId: "commit-flow-draft" });
    expect((await project.get()).resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "Flow",
          metadata: expect.objectContaining({
            id: prepared.changes[0]!.ref.slice("flow:".length),
          }),
        }),
      ]),
    );
  });

  it("validates nested Flow input mappings against the draft base revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-nested-flow-draft-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const child = PragmaFlowResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "Flow",
      metadata: {
        id: "7k2m9q4v8np6r3dt",
        name: "Child",
        description: "Accepts a typed goal.",
        tags: [],
      },
      spec: {
        input: {
          schema: {
            type: "object",
            properties: { goal: { type: "string" } },
            required: ["goal"],
            additionalProperties: false,
          },
        },
        graph: {
          start: "finish",
          steps: {
            finish: {
              human: {
                selectionMode: "single",
                prompt: { segments: [{ text: "Finish?" }] },
                options: [
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ],
              },
            },
          },
          transitions: { finish: { end: true } },
          loops: {},
        },
      },
    });
    await project.publish({ expectedRevision: 0, resources: [child] });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const created = await adapter.createFlowDraft({
      expectedProjectRevision: 1,
      metadata: {
        name: "Parent",
        description: "Passes its typed input to a child Flow.",
        tags: [],
      },
      input: {
        schema: {
          type: "object",
          properties: { goal: { type: "number" } },
          required: ["goal"],
          additionalProperties: false,
        },
      },
    });

    const updated = await adapter.updateFlowDraft({
      draftId: created.draftId,
      expectedDraftRevision: 0,
      operations: [
        {
          type: "upsert_step",
          stepId: "child",
          step: { flow: { ref: "flow:7k2m9q4v8np6r3dt" } },
        },
        { type: "set_start", stepId: "child" },
        { type: "set_transition", stepId: "child", transition: { end: true } },
      ],
    });

    expect(updated.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "flow.contract.type_mismatch",
          path: ["spec", "graph", "steps", "child", "input"],
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

function expert(description: string, runtimeRef: string, id = "1xddvess309a6gme"): string {
  return [
    "apiVersion: pragma/v3",
    "kind: Expert",
    "metadata:",
    `  id: ${id}`,
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
    "apiVersion: pragma/v3",
    "kind: Automation",
    "metadata:",
    "  id: 55af1v8nmn4j0h3z",
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
    "      ref: expert:3sfd30h5017wd17d",
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
