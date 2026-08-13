import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExpertAgentStreamEventSchema } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  assertRuntimeConformance,
  inspectRuntimeObservationConformance,
  inspectRuntimeProbeEvidenceConformance,
} from "../src/runtime/conformance.ts";
import { defineExpert } from "../src/agent/expert-agent.ts";
import { defineRuntimeFeatures, runtimeFeature } from "../src/runtime/features.ts";
import { createRuntimeProbeEvidence } from "../src/runtime/probe-evidence.ts";
import { createRuntimeTestFeatures, defineRuntimeTestDriver } from "../src/testing/index.ts";
import type { RuntimeStreamEvent } from "../src/runtime/stream-events.ts";
import { openRuntimeSession } from "../src/runtime/session-factory.ts";

describe("Runtime conformance runner", () => {
  it("accepts ordered streaming and one complete MCP tool lifecycle", () => {
    const runtime = defineRuntimeTestDriver({
      features: createRuntimeTestFeatures({
        enabled: ["mcp", "skills", "nativeToolLifecycle"],
      }),
      descriptor: { id: "conformance", kind: "test", displayName: "Conformance" },
      createSession: () => ({}),
      startTurn: () => ({ outputText: "SKILL_OK" }),
      mapEvent: () => ({ events: [] }),
    });
    const events = [
      event(0, "run.started", { task: "probe" }),
      event(1, "tool.started", {
        toolCallId: "tool-1",
        toolName: "mcp_list_expert_context",
        kind: "tool",
      }),
      event(2, "tool.completed", {
        toolCallId: "tool-1",
        toolName: "mcp_list_expert_context",
        kind: "tool",
      }),
      event(3, "message.delta", {
        role: "assistant",
        contentType: "text",
        delta: "SKILL_OK",
      }),
      event(4, "message.completed", {
        role: "assistant",
        contentType: "text",
        text: "SKILL_OK",
      }),
      event(5, "run.completed", {}),
    ];

    expect(
      inspectRuntimeObservationConformance(runtime, {
        events,
        outputText: "SKILL_OK",
        expectedToolNames: ["mcp_list_expert_context"],
        expectedOutputMarkers: ["SKILL_OK"],
        requiredFeatures: ["mcp", "skills"],
        structuredOutputValidated: true,
        ownerPersistenceValidated: true,
      }),
    ).toEqual([]);
  });

  it("detects duplicate and out-of-order tool events", () => {
    const runtime = defineRuntimeTestDriver({
      descriptor: { id: "broken", kind: "test", displayName: "Broken" },
      createSession: () => ({}),
      startTurn: () => ({ outputText: "x" }),
      mapEvent: () => ({ events: [] }),
    });
    const failures = inspectRuntimeObservationConformance(runtime, {
      events: [
        event(0, "run.started", { task: "probe" }),
        event(1, "tool.completed", { toolCallId: "tool-1", toolName: "bad", kind: "tool" }),
        event(2, "run.completed", {}),
      ],
      structuredOutputValidated: false,
      ownerPersistenceValidated: false,
    });
    expect(failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "tool.terminal_without_start",
        "invariant.structured_output",
        "invariant.owner_persistence",
      ]),
    );
  });

  it("detects a terminal text snapshot that duplicates streamed output", () => {
    const runtime = defineRuntimeTestDriver({
      descriptor: { id: "duplicate-text", kind: "test", displayName: "Duplicate Text" },
      createSession: () => ({}),
      startTurn: () => ({ outputText: "hellohello" }),
      mapEvent: () => ({ events: [] }),
    });
    const failures = inspectRuntimeObservationConformance(runtime, {
      events: [
        event(0, "run.started", { task: "probe" }),
        event(1, "message.delta", {
          role: "assistant",
          contentType: "text",
          delta: "hello",
        }),
        event(2, "message.completed", {
          role: "assistant",
          contentType: "text",
          text: "hellohello",
        }),
        event(3, "run.completed", {}),
      ],
      outputText: "hellohello",
    });

    expect(failures.map(({ code }) => code)).toContain("stream.snapshot_mismatch");
  });

  it("requires Materialized, Discovered, and Executed evidence for Skills probes", () => {
    const runtime = defineRuntimeTestDriver({
      features: createRuntimeTestFeatures({ enabled: ["skills"] }),
      descriptor: { id: "skills-evidence", kind: "test", displayName: "Skills Evidence" },
      createSession: () => ({}),
      startTurn: () => ({ outputText: "x" }),
      mapEvent: () => ({ events: [] }),
    });
    const evidence = createRuntimeProbeEvidence({
      runtime: { id: "skills-evidence", kind: "test" },
      probe: { id: "skills", version: "v1" },
      environment: {
        capturedAt: "2026-08-13T00:00:00.000Z",
        platform: "test",
        architecture: "test",
      },
      command: { executable: "runtime", arguments: ["skills"] },
      assertions: [
        {
          id: "skills.executed",
          feature: "skills",
          stage: "executed",
          status: "passed",
          message: "Skill marker was observed.",
        },
      ],
      observations: [],
    });

    expect(
      inspectRuntimeProbeEvidenceConformance(runtime, evidence).map(({ code }) => code),
    ).toEqual(["evidence.stage_missing", "evidence.stage_missing"]);
  });

  it("keeps staged MCP and Skills requirements in combined evidence", () => {
    const runtime = defineRuntimeTestDriver({
      features: createRuntimeTestFeatures({ enabled: ["mcp", "skills"] }),
      descriptor: { id: "full-evidence", kind: "test", displayName: "Full Evidence" },
      createSession: () => ({}),
      startTurn: () => ({ outputText: "x" }),
      mapEvent: () => ({ events: [] }),
    });
    const evidence = createRuntimeProbeEvidence({
      runtime: { id: "full-evidence", kind: "test" },
      probe: { id: "full", version: "v1" },
      environment: {
        capturedAt: "2026-08-13T00:00:00.000Z",
        platform: "test",
        architecture: "test",
      },
      command: { executable: "runtime", arguments: ["full"] },
      assertions: [
        {
          id: "mcp.executed",
          feature: "mcp",
          stage: "executed",
          status: "passed",
          message: "MCP marker was observed.",
        },
        {
          id: "skills.executed",
          feature: "skills",
          stage: "executed",
          status: "passed",
          message: "Skill marker was observed.",
        },
      ],
      observations: [],
    });

    expect(
      inspectRuntimeProbeEvidenceConformance(runtime, evidence).map(
        ({ feature, code }) => `${feature}:${code}`,
      ),
    ).toEqual([
      "mcp:evidence.stage_missing",
      "mcp:evidence.stage_missing",
      "skills:evidence.stage_missing",
      "skills:evidence.stage_missing",
    ]);
  });

  it("rejects Supported lifecycle features without a Core preparation hook", () => {
    const base = createRuntimeTestFeatures();
    expect(() =>
      defineRuntimeFeatures({
        ...base,
        mcp: runtimeFeature.supported({
          evidence: [
            { probe: "mcp", level: "materialized", source: "real-probe" },
            { probe: "mcp", level: "discovered", source: "real-probe" },
            { probe: "mcp", level: "executed", source: "real-probe" },
          ],
        }),
      }),
    ).toThrow(/Core-owned Session preparation/);
  });

  it("rejects feature hooks outside their catalog lifecycle", () => {
    const base = createRuntimeTestFeatures();
    expect(() =>
      defineRuntimeFeatures({
        ...base,
        availability: runtimeFeature.degraded("Probe fixture.", {
          prepareSession: () => undefined,
        }),
      }),
    ).toThrow(/driver lifecycle.*prepareSession/);
    expect(() =>
      defineRuntimeFeatures({
        ...base,
        mcp: runtimeFeature.degraded("MCP fixture.", {
          prepareTurn: () => undefined,
        }),
      }),
    ).toThrow(/session lifecycle.*prepareTurn/);
  });

  it("does not promote Supported from test-only execution evidence", () => {
    const runtime = defineRuntimeTestDriver({
      features: createRuntimeTestFeatures({
        overrides: {
          textStreaming: runtimeFeature.supported({
            evidence: [{ probe: "stream", level: "executed", source: "test" }],
          }),
        },
      }),
      descriptor: { id: "test-evidence", kind: "test", displayName: "Test Evidence" },
      createSession: () => ({}),
      startTurn: () => ({ outputText: "x" }),
      mapEvent: () => ({ events: [] }),
    });

    expect(() => assertRuntimeConformance(runtime)).toThrow(
      /no executed real-Runtime probe reference/,
    );
  });

  it("uses the same derived descriptor in public and managed Session views", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-conformance-"));
    const runtime = defineRuntimeTestDriver({
      descriptor: {
        id: "descriptor-view",
        kind: "test",
        displayName: "Descriptor View",
        capabilities: { targets: ["agent"], executionLocations: ["local"] },
      },
      createSession: () => ({}),
      startTurn: () => ({ outputText: "done" }),
      mapEvent: () => ({ events: [] }),
    });
    const expert = await defineExpert({
      id: "0000000000000001",
      name: "Descriptor Test",
      description: "Checks the managed Runtime descriptor.",
      instructions: "Reply concisely.",
      tags: ["test"],
      scope: "test",
      workspace: root,
      pragmaHome: root,
    });
    const session = await openRuntimeSession(runtime, {
      agent: expert,
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      pragmaHome: root,
      systemSessionId: "system-session",
    });

    try {
      expect(session.info().runtime).toBe(runtime.descriptor);
      expect(session.info().runtime.capabilities).toMatchObject({
        targets: ["agent"],
        executionLocations: ["local"],
        supportsStreaming: true,
        supportsMcp: false,
      });
      expect(Object.isFrozen(runtime.descriptor)).toBe(true);
      expect(Object.isFrozen(runtime.features)).toBe(true);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function event(
  sequence: number,
  type: RuntimeStreamEvent["type"],
  payload: unknown,
): RuntimeStreamEvent {
  return ExpertAgentStreamEventSchema.parse({
    schemaVersion: "pragma.stream/v1",
    eventId: `event-${sequence}`,
    sequence,
    runId: "run-1",
    emittedAt: new Date(sequence * 1_000).toISOString(),
    source: { kind: "runtime", runId: "run-1", path: [] },
    type,
    payload,
  });
}
