import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { defineExpert } from "../src/agent/expert-agent.ts";
import { defineRuntimeDriver, type RuntimeNativeSessionContext } from "../src/runtime/driver.ts";
import { defineRuntimeFeatures, runtimeFeature, runtimeStep } from "../src/runtime/features.ts";
import { openRuntimeSession } from "../src/runtime/session-factory.ts";
import { createRuntimeTestFeatures } from "../src/testing/index.ts";

describe("Runtime preparation graph", () => {
  it("prepares declared dependencies before consumers and exposes typed Feature outputs", async () => {
    const order: string[] = [];
    const mcp = runtimeFeature.session({
      id: "fixture.mcp",
      readiness: runtimeFeature.degraded("Fixture implementation."),
      async prepare() {
        order.push("mcp");
        return { url: "http://127.0.0.1/mcp" };
      },
    });
    const skills = runtimeFeature.session({
      id: "fixture.skills",
      readiness: runtimeFeature.degraded("Fixture implementation."),
      needs: { mcp },
      async prepare(_context, { mcp: preparedMcp }) {
        order.push(`skills:${preparedMcp.url}`);
        return { directory: "/tmp/skills" };
      },
    });
    const features = defineRuntimeFeatures({
      ...createRuntimeTestFeatures(),
      mcp,
      skills,
    });
    const runtime = defineRuntimeDriver({
      descriptor: { id: "graph", kind: "test", displayName: "Graph" },
      features,
      createSession(context) {
        order.push(`session:${context.features.mcp.url}:${context.features.skills.directory}`);
        return {};
      },
      startTurn: () => ({ outputText: "ok" }),
      mapEvent: () => ({ events: [] }),
    });
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-graph-"));
    const expert = await createExpert(root);

    try {
      const session = await openRuntimeSession(runtime, {
        agent: expert,
        owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
        pragmaHome: root,
        systemSessionId: "runtime-graph",
      });
      await session.close();
      expect(order).toEqual([
        "mcp",
        "skills:http://127.0.0.1/mcp",
        "session:http://127.0.0.1/mcp:/tmp/skills",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seals preparation resources before native Session creation", async () => {
    expectTypeOf<RuntimeNativeSessionContext>().not.toHaveProperty("resources");
    let nativeContextHadResources = true;
    const runtime = defineRuntimeDriver({
      descriptor: { id: "sealed-native-context", kind: "test", displayName: "Sealed Native" },
      features: createRuntimeTestFeatures(),
      createSession(context) {
        nativeContextHadResources = "resources" in context;
        return {};
      },
      startTurn: () => ({ outputText: "ok" }),
      mapEvent: () => ({ events: [] }),
    });
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-sealed-context-"));
    const expert = await createExpert(root);

    try {
      const session = await openRuntimeSession(runtime, {
        agent: expert,
        owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
        pragmaHome: root,
        systemSessionId: "runtime-sealed-context",
      });
      await session.close();
      expect(nativeContextHadResources).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs independent Session preparation roots concurrently", async () => {
    let started = 0;
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const first = runtimeStep.session({
      id: "fixture.concurrent-first",
      async prepare() {
        started += 1;
        if (started === 2) resolveBothStarted();
        await bothStarted;
      },
    });
    const second = runtimeStep.session({
      id: "fixture.concurrent-second",
      async prepare() {
        started += 1;
        if (started === 2) resolveBothStarted();
        await bothStarted;
      },
    });
    const runtime = defineRuntimeDriver({
      descriptor: { id: "concurrent-graph", kind: "test", displayName: "Concurrent Graph" },
      features: createRuntimeTestFeatures(),
      sessionSteps: [first, second],
      createSession: () => ({}),
      startTurn: () => ({ outputText: "ok" }),
      mapEvent: () => ({ events: [] }),
    });
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-concurrent-graph-"));
    const expert = await createExpert(root);

    try {
      const session = await openRuntimeSession(runtime, {
        agent: expert,
        owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
        pragmaHome: root,
        systemSessionId: "runtime-concurrent-graph",
      });
      await session.close();
      expect(started).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 1_000);

  it("rolls back successful parallel Session preparation branches when a sibling fails", async () => {
    let released = false;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const succeeds = runtimeStep.session({
      id: "fixture.parallel-success",
      async prepare(context) {
        await context.resources.acquire(
          "fixture.parallel-resource",
          () => ({}),
          () => {
            released = true;
          },
        );
        resolveReady();
      },
    });
    const fails = runtimeStep.session({
      id: "fixture.parallel-failure",
      async prepare() {
        await ready;
        throw new Error("parallel preparation failed");
      },
    });
    const runtime = defineRuntimeDriver({
      descriptor: { id: "parallel-cleanup", kind: "test", displayName: "Parallel Cleanup" },
      features: createRuntimeTestFeatures(),
      sessionSteps: [succeeds, fails],
      createSession: () => {
        throw new Error("native Session creation must not run");
      },
      startTurn: () => ({ outputText: "ok" }),
      mapEvent: () => ({ events: [] }),
    });
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-parallel-cleanup-"));
    const expert = await createExpert(root);

    try {
      await expect(
        openRuntimeSession(runtime, {
          agent: expert,
          owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
          pragmaHome: root,
          systemSessionId: "runtime-parallel-cleanup",
        }),
      ).rejects.toThrow("parallel preparation failed");
      expect(released).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects preparation cycles before native Session creation", async () => {
    const skills = runtimeFeature.session({
      id: "fixture.skills",
      readiness: runtimeFeature.degraded("Fixture implementation."),
      needs: {},
      prepare: () => ({ value: "skills" }),
    });
    const mcp = runtimeFeature.session({
      id: "fixture.mcp",
      readiness: runtimeFeature.degraded("Fixture implementation."),
      needs: { skills },
      prepare: () => ({ value: "mcp" }),
    });
    (skills.needs as { mcp?: typeof mcp }).mcp = mcp;
    const runtime = defineRuntimeDriver({
      descriptor: { id: "cycle", kind: "test", displayName: "Cycle" },
      features: defineRuntimeFeatures({ ...createRuntimeTestFeatures(), mcp, skills }),
      createSession: () => {
        throw new Error("native Session creation must not run");
      },
      startTurn: () => ({ outputText: "ok" }),
      mapEvent: () => ({ events: [] }),
    });
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-cycle-"));
    const expert = await createExpert(root);

    try {
      await expect(
        openRuntimeSession(runtime, {
          agent: expert,
          owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
          pragmaHome: root,
          systemSessionId: "runtime-cycle",
        }),
      ).rejects.toThrow(/dependency cycle/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prepares private turn steps before public turn Features and exposes both outputs", async () => {
    const order: string[] = [];
    const promptContext = runtimeStep.turn({
      id: "fixture.prompt-context",
      async prepare(context) {
        order.push(`step:${context.query}`);
        return { prefix: "prepared" };
      },
    });
    const modelSelection = runtimeFeature.turn({
      id: "fixture.model-selection",
      readiness: runtimeFeature.degraded("Fixture implementation."),
      needs: { promptContext },
      prepare(_context, { promptContext: preparedPromptContext }) {
        order.push(`feature:${preparedPromptContext.prefix}`);
        return { value: preparedPromptContext.prefix };
      },
    });
    const runtime = defineRuntimeDriver({
      descriptor: { id: "turn-graph", kind: "test", displayName: "Turn graph" },
      features: defineRuntimeFeatures({
        ...createRuntimeTestFeatures(),
        modelSelection,
      }),
      turnSteps: [promptContext],
      createSession: () => ({}),
      startTurn: (_session, context) => {
        order.push(
          `turn:${context.features.modelSelection.value}:${context.steps.get(promptContext).prefix}`,
        );
        return { outputText: "ok" };
      },
      mapEvent: () => ({ events: [] }),
    });
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-turn-graph-"));
    const expert = await createExpert(root);

    try {
      const session = await openRuntimeSession(runtime, {
        agent: expert,
        owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
        pragmaHome: root,
        systemSessionId: "runtime-turn-graph",
      });
      await session.submit({ query: "hello", execution: {} }).result;
      await session.close();
      expect(order).toEqual(["step:hello", "feature:prepared", "turn:prepared:prepared"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases turn Feature resources when preparation fails", async () => {
    let released = false;
    const modelSelection = runtimeFeature.turn({
      id: "fixture.failing-turn-feature",
      readiness: runtimeFeature.degraded("Fixture implementation."),
      async prepare(context) {
        await context.resources.acquire(
          "fixture.turn-resource",
          () => ({ value: "resource" }),
          () => {
            released = true;
          },
        );
        throw new Error("turn preparation failed");
      },
    });
    const runtime = defineRuntimeDriver({
      descriptor: { id: "turn-cleanup", kind: "test", displayName: "Turn cleanup" },
      features: defineRuntimeFeatures({
        ...createRuntimeTestFeatures(),
        modelSelection,
      }),
      createSession: () => ({}),
      startTurn: () => ({ outputText: "must not execute" }),
      mapEvent: () => ({ events: [] }),
    });
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-turn-cleanup-"));
    const expert = await createExpert(root);

    try {
      const session = await openRuntimeSession(runtime, {
        agent: expert,
        owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
        pragmaHome: root,
        systemSessionId: "runtime-turn-cleanup",
      });
      await expect(session.submit({ query: "hello", execution: {} }).result).rejects.toThrow(
        "turn preparation failed",
      );
      expect(released).toBe(true);
      await session.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects turn Features that depend on Session preparation nodes", async () => {
    const sessionStep = runtimeStep.session({
      id: "fixture.session-step",
      prepare: () => ({ value: "session" }),
    });
    const modelSelection = runtimeFeature.turn({
      id: "fixture.cross-phase-turn-feature",
      readiness: runtimeFeature.degraded("Fixture implementation."),
      needs: { sessionStep },
      prepare: () => ({ value: "turn" }),
    });
    const runtime = defineRuntimeDriver({
      descriptor: { id: "cross-phase", kind: "test", displayName: "Cross phase" },
      features: defineRuntimeFeatures({
        ...createRuntimeTestFeatures(),
        modelSelection,
      }),
      sessionSteps: [sessionStep],
      createSession: () => ({}),
      startTurn: () => ({ outputText: "must not execute" }),
      mapEvent: () => ({ events: [] }),
    });
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-cross-phase-"));
    const expert = await createExpert(root);

    try {
      const session = await openRuntimeSession(runtime, {
        agent: expert,
        owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
        pragmaHome: root,
        systemSessionId: "runtime-cross-phase",
      });
      await expect(session.submit({ query: "hello", execution: {} }).result).rejects.toThrow(
        /depends on a session node/,
      );
      await session.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createExpert(root: string) {
  return await defineExpert({
    id: "0000000000000001",
    name: "Runtime Graph Test",
    description: "Exercises Runtime preparation dependencies.",
    instructions: "Reply concisely.",
    tags: ["test"],
    scope: "test",
    workspace: root,
    pragmaHome: root,
  });
}
