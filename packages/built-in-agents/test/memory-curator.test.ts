import {
  DEFAULT_MEMORY_STORAGE_POLICY,
  type MemoryExtractorProfile,
  type MemoryExtractorProfileStore,
} from "@pragma/memory";
import {
  MemoryEvidenceEnvelopeSchema,
  type SkillExtractionInput,
  type SkillSourceSnapshot,
} from "@pragma/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createBuiltInMemoryCurator,
  renderEpisodicExtractionPrompt,
  renderSkillExtractionPrompt,
  type MemoryCuratorExecutionPort,
} from "../src/memory-curator.ts";
import { createSkillDraftSession } from "../src/skill-draft.ts";

const profile: MemoryExtractorProfile = {
  schemaVersion: "pragma.memory-extractor-profile/v1",
  revision: 1,
  mode: "inherit-default",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

describe("Memory Curator Evidence prompts", () => {
  it("keeps content and agent stewardship while removing envelope metadata", () => {
    const evidence = [
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "message-user",
        topic: "execution.message.appended",
        schemaRef: "pragma.memory.execution-message/v2",
        sourceRef: {
          type: "pragma.execution-event",
          id: "source-event-id",
          canonicalEventId: "canonical-event-id",
          cursor: "42",
        },
        subjectRefs: [
          { type: "pragma.execution", id: "execution-id" },
          { type: "pragma.invocation", id: "invocation-id" },
        ],
        correlationId: "execution-id",
        causationId: "canonical-event-id",
        occurredAt: "2026-08-13T06:00:00.000Z",
        visibility: { mode: "host-private" },
        sensitivity: "confidential",
        bindings: [{ consumerRef: { type: "pragma.expert", id: "agent-a" }, access: "allow" }],
        attribution: {
          rootRef: { type: "pragma.expert-team", id: "team-a" },
          producerRefs: [{ type: "pragma.expert", id: "agent-a" }],
        },
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "local-candidates",
          appliedRevisions: [{ scope: "global", revision: 7 }],
        },
        payload: { message: { role: "user", text: "先让我确认方案，再执行依赖树净化。" } },
      }),
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "tool-failed",
        topic: "execution.tool.failed",
        schemaRef: "pragma.memory.tool-event/v2",
        sourceRef: {
          type: "pragma.execution-event",
          id: "tool-source-event-id",
          canonicalEventId: "tool-canonical-event-id",
        },
        subjectRefs: [{ type: "pragma.execution", id: "execution-id" }],
        occurredAt: "2026-08-13T06:01:00.000Z",
        visibility: { mode: "host-private" },
        sensitivity: "confidential",
        bindings: [],
        attribution: {
          rootRef: { type: "pragma.expert-team", id: "team-a" },
          producerRefs: [{ type: "pragma.expert", id: "agent-a" }],
        },
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "local-candidates",
          appliedRevisions: [],
        },
        payload: { toolCallId: "call-1", toolName: "search_expert_context", phase: "failed" },
      }),
    ];

    const prompt = renderEpisodicExtractionPrompt({
      schemaVersion: "pragma.memory-episodic-extraction-input/v2",
      jobId: "job-id",
      executionId: "execution-id",
      evidence,
      omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
    });

    expect(prompt).toContain('"root":"pragma.expert-team:team-a"');
    expect(prompt).toContain('"producers":["pragma.expert:agent-a"]');
    expect(prompt.match(/"root":"pragma\.expert-team:team-a"/gu)).toHaveLength(1);
    expect(prompt).toContain(
      '"id":"message-user","at":"2026-08-13T06:00:00.000Z","steward":0,"kind":"user","text":"先让我确认方案，再执行依赖树净化。"',
    );
    expect(prompt).toContain(
      '"id":"tool-failed","at":"2026-08-13T06:01:00.000Z","steward":0,"kind":"tool","tool":"search_expert_context","phase":"failed"',
    );
    for (const discardedField of [
      "schemaVersion",
      "source-event-id",
      "canonical-event-id",
      "execution-id",
      "host-private",
      "confidential",
      "policySnapshot",
      "bindings",
      "toolCallId",
    ]) {
      expect(prompt).not.toContain(discardedField);
    }
  });

  it("uses the compact projection when applying the prompt byte budget", () => {
    const template = MemoryEvidenceEnvelopeSchema.parse({
      schemaVersion: "pragma.memory-evidence/v1",
      messageId: "template",
      topic: "execution.message.appended",
      schemaRef: "pragma.memory.execution-message/v2",
      sourceRef: {
        type: "pragma.execution-event",
        id: "source-event-id",
        canonicalEventId: "canonical-event-id",
      },
      subjectRefs: [
        { type: "pragma.execution", id: "execution-id" },
        { type: "pragma.invocation", id: "invocation-id" },
      ],
      correlationId: "execution-id",
      causationId: "canonical-event-id",
      occurredAt: "2026-08-13T06:00:00.000Z",
      visibility: { mode: "host-private" },
      sensitivity: "confidential",
      bindings: [{ consumerRef: { type: "pragma.expert", id: "agent-a" }, access: "allow" }],
      attribution: {
        rootRef: { type: "pragma.expert-team", id: "team-a" },
        producerRefs: [{ type: "pragma.expert", id: "agent-a" }],
      },
      policySnapshot: {
        capture: true,
        recall: true,
        learning: "local-candidates",
        appliedRevisions: Array.from({ length: 24 }, (_, revision) => ({
          scope: "global" as const,
          revision,
        })),
      },
      payload: { message: { role: "user", text: "template" } },
    });
    const evidence = Array.from({ length: 200 }, (_, index) =>
      MemoryEvidenceEnvelopeSchema.parse({
        ...template,
        messageId: `message-${index}`,
        occurredAt: `2026-08-13T06:00:00.${String(index).padStart(3, "0")}Z`,
        payload: { message: { role: "user", text: `useful-${index}` } },
      }),
    );

    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeGreaterThan(78_000);

    const prompt = renderEpisodicExtractionPrompt({
      schemaVersion: "pragma.memory-episodic-extraction-input/v2",
      jobId: "job-id",
      executionId: "execution-id",
      evidence,
      omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
    });

    expect(prompt).toContain('"id":"message-0"');
    expect(prompt).toContain('"id":"message-199"');
  });
});

describe("Memory Curator Skill drafts", () => {
  it("shows the host-computed source eligibility before asking for a draft", () => {
    const eligiblePrompt = renderSkillExtractionPrompt(skillInput());
    expect(eligiblePrompt).toContain('"eligible":true');
    expect(eligiblePrompt).toContain('"highValueEpisodicCount":3');
    expect(eligiblePrompt).toContain('"conversationCount":2');
    expect(eligiblePrompt).toContain('"successfulOrRecoveredCount":2');

    const ineligiblePrompt = renderSkillExtractionPrompt(ineligibleSkillInput());
    expect(ineligiblePrompt).toContain('"eligible":false');
    expect(ineligiblePrompt).toContain(
      'return exactly {"retain":false,"reason":"insufficient-independent-sources"}',
    );
  });

  it("returns an MCP-visible error and a clean rejection when evidence cannot meet the threshold", async () => {
    const input = ineligibleSkillInput();
    const session = createSkillDraftSession(input);
    const begin = session.tools.find((tool) => tool.name === "begin_skill_draft")!;

    expect(session.output()).toEqual({
      retain: false,
      reason: "insufficient-independent-sources",
    });
    const result = await begin.call(metadata(input), undefined);

    expect(result).toMatchObject({
      isError: true,
      details: { ok: false, terminal: true },
    });
    expect(result.text).toContain("source_threshold_not_met");
    expect(session.output()).toEqual({
      retain: false,
      reason: "insufficient-independent-sources",
    });

    const repeated = await begin.call(metadata(input), undefined);
    expect(repeated).toMatchObject({
      isError: true,
      details: { ok: false, terminal: true },
    });
    expect(repeated.text).toContain("skill_draft_begin_repair_exhausted");
  });

  it("terminates a repeated invalid begin request instead of retrying it forever", async () => {
    const session = createSkillDraftSession(skillInput());
    const begin = session.tools.find((tool) => tool.name === "begin_skill_draft")!;
    const request = {
      ...metadata(),
      route: { type: "revise" as const, bindingId: "00000000-0000-4000-8000-000000000099" },
    };

    const first = await begin.call(request, undefined);
    expect(first).toMatchObject({ isError: false, details: { ok: false } });
    expect(first.details).not.toHaveProperty("terminal", true);

    const repeated = await begin.call(request, undefined);
    expect(repeated).toMatchObject({
      isError: true,
      details: { ok: false, terminal: true },
    });
    expect(session.output()).toEqual({ retain: false, reason: "no-reusable-skill" });
  });

  it("keeps an already begun draft repairable after begin validation exhaustion", async () => {
    const session = createSkillDraftSession(skillInput());
    const begin = session.tools.find((tool) => tool.name === "begin_skill_draft")!;
    const put = session.tools.find((tool) => tool.name === "put_skill_file")!;
    const submit = session.tools.find((tool) => tool.name === "submit_skill_draft")!;
    const begun = await begin.call(metadata(), undefined);
    const draftId = (begun.details as { draftId: string }).draftId;
    const invalidRequest = {
      ...metadata(),
      route: { type: "revise" as const, bindingId: "00000000-0000-4000-8000-000000000099" },
    };

    await begin.call(invalidRequest, undefined);
    await begin.call(invalidRequest, undefined);
    expect(session.beginRepairExhausted()).toBe(true);

    await put.call(
      {
        draftId,
        path: "SKILL.md",
        content:
          "---\nname: resilient-skill\ndescription: A reusable resilient workflow.\n---\n\n# Skill",
      },
      undefined,
    );
    const submitted = await submit.call({ draftId }, undefined);
    expect(submitted).toMatchObject({ details: { ok: true } });
    expect(submitted.isError).not.toBe(true);
    expect(session.output()).toMatchObject({ retain: true });
    expect(session.beginRepairExhausted()).toBe(false);
  });

  it("keeps the Skill prompt within its byte budget when source records are large", () => {
    const input = skillInput();
    const prompt = renderSkillExtractionPrompt({
      ...input,
      sources: input.sources.map((source) => ({ ...source, body: "x".repeat(24_000) })),
    });

    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(
      DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes,
    );
  });

  it("exposes a single-object route schema and accepts a valid runtime tool call", async () => {
    const session = createSkillDraftSession(skillInput());
    const begin = session.tools.find((tool) => tool.name === "begin_skill_draft")!;
    const routeSchema = (
      begin.inputSchema as {
        readonly properties?: { readonly route?: Record<string, unknown> };
      }
    ).properties?.route;

    expect(routeSchema).toMatchObject({
      type: "object",
      properties: {
        type: { type: "string", enum: ["create", "revise", "ambiguous"] },
        bindingId: { type: "string", format: "uuid" },
        bindingIds: { type: "array", minItems: 2, maxItems: 20 },
      },
      required: ["type"],
      additionalProperties: false,
      description: expect.stringContaining('{"type":"create"}'),
    });
    expect(routeSchema).not.toHaveProperty("oneOf");

    await expect(begin.call(metadata(), undefined)).resolves.toMatchObject({
      details: { ok: true, draftId: expect.any(String) },
    });
  });

  it("repairs an invalid first submission and preserves risky multiline content in one run", async () => {
    const run = vi.fn<MemoryCuratorExecutionPort["run"]>(async (request) => {
      const session = createSkillDraftSession(request.skillInput!);
      const begin = session.tools.find((tool) => tool.name === "begin_skill_draft")!;
      const put = session.tools.find((tool) => tool.name === "put_skill_file")!;
      const submit = session.tools.find((tool) => tool.name === "submit_skill_draft")!;
      const begun = await begin.call(metadata(), undefined);
      const draftId = (begun.details as { draftId: string }).draftId;

      const invalid = await submit.call({ draftId }, undefined);
      expect(invalid.text).toContain("SKILL.md is required");

      const content = `---
name: resilient-skill
description: A reusable resilient workflow.
---

Use a fenced example:

\`\`\`json
{"message":"say \\"hello\\"","nested":{"ok":true}}
\`\`\`

Then run \`printf '%s\\n' "done"\`.
`;
      await put.call(
        {
          draftId,
          path: "SKILL.md",
          content: content.replace(
            "description: A reusable resilient workflow.",
            "description: Mismatched metadata.",
          ),
        },
        undefined,
      );
      const metadataMismatch = await submit.call({ draftId }, undefined);
      expect(metadataMismatch.text).toContain("skill_metadata_mismatch");

      await put.call({ draftId, path: "SKILL.md", content }, undefined);
      const corrected = await submit.call({ draftId }, undefined);
      expect(corrected.details).toMatchObject({ ok: true, candidateIndex: 0 });
      expect(session.output()).toMatchObject({
        retain: true,
        candidates: [{ content: { package: { files: [{ path: "SKILL.md", content }] } } }],
      });
      return {
        content: "Draft submitted.",
        runtimeId: "runtime-test",
        providerId: "provider-test",
        modelId: "model-test",
        skillOutput: session.output()!,
      };
    });
    const curator = createBuiltInMemoryCurator({ profiles: profiles(), execution: { run } });

    const result = await curator.skillExtractor.extract(skillInput());

    expect(run).toHaveBeenCalledOnce();
    expect(result.output).toMatchObject({
      retain: true,
      candidates: [{ route: { type: "create" } }],
    });
  });

  it("attaches safe parse and truncation diagnostics without including raw output", async () => {
    const secret = "private-memory-content";
    const curator = createBuiltInMemoryCurator({
      profiles: profiles(),
      execution: {
        async run() {
          return {
            content: `{"retain":true,"value":"${secret}`,
            runtimeId: "runtime-test",
            providerId: "provider-test",
            modelId: "model-test",
            finishReason: "length" as const,
            usage: {
              measurement: "reported" as const,
              input: 10,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 30,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        },
      },
    });

    const error = await curator.knowledgeExtractor
      .extract({
        schemaVersion: "pragma.memory-knowledge-extraction-input/v2",
        jobId: "job",
        rootRef: { type: "pragma.expert", id: "expert" },
        sources: [],
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(error).toMatchObject({
      code: "knowledge_extraction_output_invalid",
      outputDiagnostic: {
        closingBoundaryFound: false,
        finishReason: "length",
        truncated: true,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
    });
    expect(JSON.stringify((error as { outputDiagnostic: unknown }).outputDiagnostic)).not.toContain(
      secret,
    );
  });

  it("returns a structured failure when a Skill run ends without a draft or valid rejection", async () => {
    const curator = createBuiltInMemoryCurator({
      profiles: profiles(),
      execution: {
        async run() {
          return {
            content: "Draft submitted.",
            runtimeId: "runtime-test",
            providerId: "provider-test",
            modelId: "model-test",
          };
        },
      },
    });

    const error = await curator.skillExtractor.extract(skillInput()).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      code: "skill_extraction_output_invalid",
      retryable: true,
      runtimeId: "runtime-test",
      providerId: "provider-test",
      modelId: "model-test",
    });
  });

  it("returns route feedback and bounds invalid submissions to three attempts", async () => {
    const input = skillInput();
    const existingBindingId = "00000000-0000-4000-8000-000000000011";
    input.existingTargets.push({
      bindingId: existingBindingId,
      capabilityId: "00000000-0000-4000-8000-000000000012",
      name: "Existing Skill",
      description: "Existing target",
      normalizedKeys: ["workflow.existing"],
    });
    const session = createSkillDraftSession(input);
    const begin = session.tools.find((tool) => tool.name === "begin_skill_draft")!;
    const submit = session.tools.find((tool) => tool.name === "submit_skill_draft")!;
    const invalidRoute = await begin.call(
      {
        ...metadata(),
        route: { type: "revise", bindingId: "00000000-0000-4000-8000-000000000099" },
      },
      undefined,
    );
    expect(invalidRoute.text).toContain("route_binding_not_found");
    const duplicateRoute = await begin.call(
      {
        ...metadata(),
        route: { type: "ambiguous", bindingIds: [existingBindingId, existingBindingId] },
      },
      undefined,
    );
    expect(duplicateRoute.text).toContain("route_binding_duplicate");

    const begun = await begin.call(metadata(), undefined);
    const draftId = (begun.details as { draftId: string }).draftId;
    await submit.call({ draftId }, undefined);
    await submit.call({ draftId }, undefined);
    const exhausted = await submit.call({ draftId }, undefined);

    expect(exhausted.details).toMatchObject({ ok: false, repairExhausted: true });
    expect(exhausted.text).toContain("skill_draft_repair_exhausted");
    expect(session.repairExhausted()).toBe(true);
  });

  it("serializes parallel submissions so one draft is accepted only once", async () => {
    const session = createSkillDraftSession(skillInput());
    const begin = session.tools.find((tool) => tool.name === "begin_skill_draft")!;
    const put = session.tools.find((tool) => tool.name === "put_skill_file")!;
    const submit = session.tools.find((tool) => tool.name === "submit_skill_draft")!;
    const begun = await begin.call(metadata(), undefined);
    const draftId = (begun.details as { draftId: string }).draftId;
    await put.call(
      {
        draftId,
        path: "SKILL.md",
        content: `---\nname: resilient-skill\ndescription: A reusable resilient workflow.\n---\n\n# Skill`,
      },
      undefined,
    );

    const results = await Promise.all([
      submit.call({ draftId }, undefined),
      submit.call({ draftId }, undefined),
    ]);

    expect(
      results.filter((result) => (result.details as { ok?: boolean }).ok === true),
    ).toHaveLength(1);
    expect(results.map((result) => result.text).join("\n")).toContain("draft_already_submitted");
    expect(session.output()).toMatchObject({
      retain: true,
      candidates: [{ content: metadata().content }],
    });
    expect((session.output() as { candidates: unknown[] }).candidates).toHaveLength(1);
  });
});

function profiles(): MemoryExtractorProfileStore {
  return { get: async () => profile, update: async () => profile };
}

function skillInput(): SkillExtractionInput {
  const sources = [
    episode("episode-a", "mission-a", "succeeded"),
    episode("episode-b", "mission-a", "succeeded"),
    episode("episode-c", "mission-b", "failed"),
  ];
  return {
    schemaVersion: "pragma.memory-skill-extraction-input/v1",
    jobId: "skill-job",
    rootRef: { type: "pragma.expert", id: "expert-a" },
    sources,
    existingTargets: [],
  };
}

function metadata(input: SkillExtractionInput = skillInput()) {
  return {
    content: {
      normalizedKey: "workflow.resilient",
      applicability: ["Use for repeatable repository work."],
      failureModes: ["Generated output may be malformed."],
      recoverySteps: ["Use staged validation feedback."],
      package: { name: "resilient-skill", description: "A reusable resilient workflow." },
      replayCases: [1, 2, 3].map((index) => ({
        objective: `Replay ${index}`,
        requiredBehaviors: ["Use the staged workflow."],
        forbiddenBehaviors: [],
      })),
      boundaryCase: {
        objective: "An unrelated task",
        requiredBehaviors: ["Recognize non-applicability."],
        forbiddenBehaviors: ["Force the workflow."],
      },
    },
    sourceRefs: input.sources.map((source) => source.ref),
    route: { type: "create" as const },
  };
}

function ineligibleSkillInput(): SkillExtractionInput {
  const input = skillInput();
  return {
    ...input,
    sources: input.sources.map((source) => ({
      ...source,
      conversationRef: { type: "pragma.mission", id: "mission-a" },
    })),
  };
}

function episode(
  id: string,
  conversationId: string,
  outcome: SkillSourceSnapshot["outcome"],
): SkillSourceSnapshot {
  return {
    ref: { kind: "episodic", id, revision: 1 },
    rootRef: { type: "pragma.expert", id: "expert-a" },
    conversationRef: { type: "pragma.mission", id: conversationId },
    sourceExecutionIds: [`execution-${id}`],
    producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
    title: `Episode ${id}`,
    body: "A reusable workflow was completed.",
    outcome,
    hasSuccessfulRecovery: false,
    observedAt: "2026-08-12T00:00:00.000Z",
    verified: true,
    valueScore: 0.9,
    visibility: { mode: "host-private" },
    sensitivity: "internal",
  };
}
