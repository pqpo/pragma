import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PragmaFlowRunDryCaseSchema } from "@pragma/evaluation/ast";
import { PRAGMA_TEXT_LIMITS } from "@pragma/shared";
import { describe, expect, it } from "vitest";
import {
  PragmaFlowResourceSchema,
  PragmaRuntimeProfileResourceSchema,
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
        expect.objectContaining({ ref: runtimeRef, kind: "created" }),
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

  it("reuses an existing compatible project RuntimeProfile without creating a duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-existing-runtime-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const runtime = PragmaRuntimeProfileResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "RuntimeProfile",
      metadata: {
        id: "2h3j4k5m6n7p8q9r",
        name: "Existing Writer Runtime",
        description: "A project RuntimeProfile that already selects the requested model.",
        tags: [],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: {
          runtimeId: "test",
          providerId: "test",
          model: "model",
        },
      },
    });
    await project.publish({ expectedRevision: 0, resources: [runtime] });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = "runtime-profile:2h3j4k5m6n7p8q9r";

    const prepared = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 1,
        sources: [expert("Uses the existing RuntimeProfile", runtimeRef)],
      }),
    );

    expect(prepared.changes).toEqual([
      expect.objectContaining({
        ref: "expert:1xddvess309a6gme",
        kind: "created",
      }),
    ]);
    expect(prepared.changes.some((change) => change.ref === runtimeRef)).toBe(false);
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

  it("prepares a Flow and its later test set in independent commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-flow-draft-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state"), [emptyDescriptionMcpCapability()]),
    );
    const description = "发布审批：验证非空 description";
    const created = await adapter.createFlowDraft({
      expectedProjectRevision: 0,
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
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
    expect(graphComplete.diagnostics).toEqual([]);
    await expect(adapter.validateFlowDraft(created.draftId)).resolves.toMatchObject({
      resource: { metadata: { description } },
      diagnostics: [],
    });
    await expect(
      adapter.prepareFlowDraft({
        draftId: created.draftId,
        expectedDraftRevision: 2,
        additionalSources: [evaluationSource(created.resource.metadata.id)],
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "evaluation.independent_prepare_required" })],
    });
    const prepared = requirePrepared(
      await adapter.prepareFlowDraft({
        draftId: created.draftId,
        expectedDraftRevision: 2,
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
    expect(await project.get()).toMatchObject({
      revision: 1,
      resources: [
        expect.objectContaining({
          kind: "Flow",
          metadata: expect.objectContaining({ id: created.resource.metadata.id }),
        }),
      ],
    });

    const evaluation = await adapter.createEvaluationDraft({
      mode: "create",
      expectedProjectRevision: 1,
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Release approval run dry",
        description: "Verifies the release approval path.",
        tags: ["run-dry"],
      },
      targetRef: `flow:${created.resource.metadata.id}`,
    });
    expect(evaluation.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "evaluation.draft.cases_empty" })]),
    );
    const evaluationWithCase = await adapter.updateEvaluationDraft({
      draftId: evaluation.draftId,
      expectedDraftRevision: 0,
      operations: [
        {
          type: "upsert_case",
          case: {
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
        },
      ],
    });
    await expect(
      adapter.runEvaluationDraft({
        draftId: evaluation.draftId,
        caseIds: ["ship"],
      }),
    ).resolves.toMatchObject({
      requestedCases: [expect.objectContaining({ id: "ship", passed: true })],
      suite: { passed: true, total: 1, passedCount: 1, failedCount: 0 },
      coverage: { missing: [] },
    });
    const evaluationPrepared = requirePrepared(
      await adapter.prepareEvaluationDraft({
        draftId: evaluation.draftId,
        expectedDraftRevision: evaluationWithCase.draftRevision,
      }),
    );
    expect(evaluationPrepared.changes).toEqual([
      expect.objectContaining({
        ref: "evaluation:7h8j9k0m1n2p3q4r",
        kind: "created",
      }),
    ]);
    await adapter.commit({
      changeSetId: evaluationPrepared.changeSetId,
      operationId: "commit-release-evaluation",
    });
    const snapshot = await project.get();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "Flow" }),
        expect.objectContaining({
          kind: "Evaluation",
          spec: expect.objectContaining({
            target: { ref: `flow:${created.resource.metadata.id}` },
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
        id: "9h0j1k2m3n4p5q6r",
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

  it("runs selected cases with cumulative coverage and blocks a failing full suite", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-evaluation-draft-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const flow = approvalRouteFlow();
    expect(await project.validateChanges({ baseRevision: 0, upserts: [flow] })).toEqual([]);
    await project.publish({ expectedRevision: 0, resources: [flow] });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const evaluation = await adapter.createEvaluationDraft({
      mode: "create",
      expectedProjectRevision: 1,
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Approval route Run Dry",
        description: "Covers both approval routes.",
        tags: ["run-dry"],
      },
      targetRef: "flow:8h9j0k1m2n3p4q5r",
    });
    const cases = approvalRouteCases();
    const updated = await adapter.updateEvaluationDraft({
      draftId: evaluation.draftId,
      expectedDraftRevision: 0,
      operations: cases.map((testCase) => ({ type: "upsert_case" as const, case: testCase })),
    });
    await expect(
      adapter.updateEvaluationDraft({
        draftId: evaluation.draftId,
        expectedDraftRevision: updated.draftRevision,
        operations: Array.from({ length: 11 }, (_, index) => ({
          type: "remove_case" as const,
          caseId: `case-${index}`,
        })),
      }),
    ).rejects.toThrow("1 to 10 operations");
    await expect(
      adapter.runEvaluationDraft({
        draftId: evaluation.draftId,
        caseIds: Array.from({ length: 11 }, (_, index) => `case-${index}`),
      }),
    ).rejects.toThrow("1 to 10 unique case IDs");

    await expect(
      adapter.runEvaluationDraft({
        draftId: evaluation.draftId,
        caseIds: ["approve"],
      }),
    ).resolves.toMatchObject({
      requestedCases: [expect.objectContaining({ id: "approve", passed: true })],
      suite: {
        passed: true,
        total: 2,
        passedCount: 2,
        failedCount: 0,
        failedCaseIds: [],
      },
      coverage: { passed: true, missing: [] },
    });
    const prepared = requirePrepared(
      await adapter.prepareEvaluationDraft({
        draftId: evaluation.draftId,
        expectedDraftRevision: updated.draftRevision,
      }),
    );
    await adapter.commit({
      changeSetId: prepared.changeSetId,
      operationId: "commit-evaluation-draft",
    });

    const edit = await adapter.createEvaluationDraft({
      mode: "edit",
      expectedProjectRevision: 2,
      evaluationRef: "evaluation:7h8j9k0m1n2p3q4r",
    });
    const brokenReject = PragmaFlowRunDryCaseSchema.parse({
      ...cases[1],
      expect: { ...cases[1]!.expect, path: ["decision"] },
    });
    const broken = await adapter.updateEvaluationDraft({
      draftId: edit.draftId,
      expectedDraftRevision: 0,
      operations: [{ type: "upsert_case", case: brokenReject }],
    });
    await expect(
      adapter.runEvaluationDraft({ draftId: edit.draftId, caseIds: ["approve"] }),
    ).resolves.toMatchObject({
      requestedCases: [expect.objectContaining({ id: "approve", passed: true })],
      suite: { passed: false, failedCaseIds: ["reject"] },
    });
    await expect(
      adapter.prepareEvaluationDraft({
        draftId: edit.draftId,
        expectedDraftRevision: broken.draftRevision,
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [
        expect.objectContaining({
          code: "evaluation.case.path",
          message: expect.stringContaining("reject"),
        }),
      ],
    });
  });

  it("requires an Evaluation draft to target a committed Flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-evaluation-target-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const evaluation = await adapter.createEvaluationDraft({
      mode: "create",
      expectedProjectRevision: 0,
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Uncommitted target",
        description: "Must not attach to an uncommitted Flow draft.",
        tags: [],
      },
      targetRef: "flow:8h9j0k1m2n3p4q5r",
    });

    expect(evaluation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "evaluation.draft.target_missing",
          message: expect.stringContaining("committed Flow"),
        }),
      ]),
    );
    await expect(
      adapter.prepareEvaluationDraft({
        draftId: evaluation.draftId,
        expectedDraftRevision: evaluation.draftRevision,
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "evaluation.draft.target_missing" }),
      ]),
    });
  });

  it("rejects Evaluation YAML through the generic prepare path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-evaluation-generic-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopDefaultAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );

    await expect(
      adapter.prepare({
        expectedProjectRevision: 0,
        sources: [evaluationSource("8h9j0k1m2n3p4q5r")],
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "evaluation.independent_prepare_required" })],
    });
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
        sources: [automationWithPrompt("p".repeat(PRAGMA_TEXT_LIMITS.automation.prompt + 1))],
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

function evaluationSource(flowId: string): string {
  return [
    "apiVersion: pragma/v3",
    "kind: Evaluation",
    "metadata:",
    "  id: 7h8j9k0m1n2p3q4r",
    "  name: Run Dry test set",
    "  description: Must be prepared separately.",
    "  tags: []",
    "spec:",
    `  target: { ref: "flow:${flowId}" }`,
    "  method:",
    "    type: flow-run-dry",
    "    cases:",
    "      - id: ship",
    "        name: Ship",
    "        input: {}",
    "        mocks:",
    "          approve:",
    "            expectInput: {}",
    '            expectPrompt: "Release?"',
    "            output: { selection: ship }",
    "        expect:",
    "          status: succeeded",
    "          path: [approve]",
    "          output: { selection: ship }",
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

function approvalRouteFlow() {
  return PragmaFlowResourceSchema.parse({
    apiVersion: "pragma/v3",
    kind: "Flow",
    metadata: {
      id: "8h9j0k1m2n3p4q5r",
      name: "Approval route",
      description: "Routes an approval decision.",
      tags: [],
    },
    spec: {
      graph: {
        start: "decision",
        steps: {
          decision: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Approve?" }] },
              options: [
                { value: "approve", label: "Approve" },
                { value: "reject", label: "Reject" },
              ],
            },
          },
          approved: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Published" }] },
              options: [
                { value: "done", label: "Done" },
                { value: "back", label: "Back" },
              ],
            },
          },
          rejected: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Cancelled" }] },
              options: [
                { value: "done", label: "Done" },
                { value: "back", label: "Back" },
              ],
            },
          },
        },
        transitions: {
          decision: {
            route: "selection",
            cases: { approve: "approved" },
            fallback: "rejected",
          },
          approved: { end: true },
          rejected: { end: true },
        },
        loops: {},
      },
    },
  });
}

function approvalRouteCases() {
  return [
    PragmaFlowRunDryCaseSchema.parse({
      id: "approve",
      name: "Approve",
      input: {},
      mocks: {
        decision: {
          expectInput: {},
          expectPrompt: "Approve?",
          output: { selection: "approve" },
        },
        approved: {
          expectInput: {},
          expectPrompt: "Published",
          output: { selection: "done" },
        },
      },
      expect: {
        status: "succeeded",
        path: ["decision", "approved"],
        output: { selection: "done" },
      },
    }),
    PragmaFlowRunDryCaseSchema.parse({
      id: "reject",
      name: "Reject",
      input: {},
      mocks: {
        decision: {
          expectInput: {},
          expectPrompt: "Approve?",
          output: { selection: "reject" },
        },
        rejected: {
          expectInput: {},
          expectPrompt: "Cancelled",
          output: { selection: "done" },
        },
      },
      expect: {
        status: "succeeded",
        path: ["decision", "rejected"],
        output: { selection: "done" },
      },
    }),
  ];
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
      schemaVersion: "pragma.capability/v2",
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
      schemaVersion: "pragma.capability/v2",
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
