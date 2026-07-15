import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeContextRecordSchema,
  type Invocation,
  type RuntimeContextRecord,
} from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  ContextResolutionService,
  createFileExecutionStore,
  defineContextIdResolver,
  freshContextIdResolver,
  resolveContextId,
} from "../src/index.ts";

describe("ContextResolutionService", () => {
  it("selects any earlier compatible Context in stable history order", async () => {
    const fixture = await createFixture();
    let candidates: readonly string[] = [];
    let selectedRuntimeId: string | undefined;
    const resolver = defineContextIdResolver({
      id: "test.select-first",
      version: "1.0.0",
      resolve: ({ previousContexts, freshContextId, target }) => {
        candidates = previousContexts.map((context) => context.contextId);
        selectedRuntimeId = target.runtimeId;
        return previousContexts[0]?.contextId ?? freshContextId;
      },
    });

    const resolution = await new ContextResolutionService(fixture.store).resolve({
      executionId: "execution",
      invocationId: "third",
      parentInvocationId: "root",
      input: "third",
      state: { revision: true },
      source: { kind: "flow", flowId: "flow", stepId: "review", visit: 3 },
      owner: fixture.owner,
      expert: fixture.expert,
      runtimeId: "runtime",
      resolver,
      freshContextId: "fresh-third",
    });

    expect(candidates).toEqual(["context-1", "context-2"]);
    expect(selectedRuntimeId).toBe("runtime");
    expect(resolution).toMatchObject({
      disposition: "reused",
      context: { contextId: "context-1" },
    });
  });

  it("rejects empty, throwing, and asynchronous resolvers", () => {
    const base = resolutionContext();
    expect(() =>
      resolveContextId(
        defineContextIdResolver({ id: "empty", version: "1", resolve: () => "" }),
        base,
      ),
    ).toThrow("empty contextId");
    expect(() =>
      resolveContextId(
        defineContextIdResolver({
          id: "throwing",
          version: "1",
          resolve: () => {
            throw new Error("broken");
          },
        }),
        base,
      ),
    ).toThrow("broken");
    expect(() =>
      resolveContextId(
        defineContextIdResolver({
          id: "async",
          version: "1",
          resolve: (() => Promise.resolve("context")) as unknown as () => string,
        }),
        base,
      ),
    ).toThrow("synchronous");
  });

  it("uses a fresh Core-generated ID by default", () => {
    expect(resolveContextId(freshContextIdResolver, resolutionContext())).toBe("fresh");
    expect(
      resolveContextId(freshContextIdResolver, {
        ...resolutionContext(),
        freshContextId: "another-fresh-context",
      }),
    ).toBe("another-fresh-context");
  });

  it("rejects closed Contexts and Expert identity collisions", async () => {
    const fixture = await createFixture({ closeFirst: true });
    const fixed = (id: string) =>
      defineContextIdResolver({ id: `test.fixed.${id}`, version: "1", resolve: () => id });
    const service = new ContextResolutionService(fixture.store);
    await expect(
      service.resolve({
        executionId: "execution",
        invocationId: "closed",
        parentInvocationId: "root",
        input: null,
        state: {},
        source: { kind: "flow", flowId: "flow", stepId: "review", visit: 3 },
        owner: fixture.owner,
        expert: fixture.expert,
        runtimeId: "runtime",
        resolver: fixed("context-1"),
      }),
    ).rejects.toThrow("closed");
    await expect(
      service.resolve({
        executionId: "execution",
        invocationId: "collision",
        parentInvocationId: "root",
        input: null,
        state: {},
        source: { kind: "flow", flowId: "flow", stepId: "other", visit: 1 },
        owner: fixture.owner,
        expert: { id: "other-expert", version: "1.0.0" },
        runtimeId: "runtime",
        resolver: fixed("context-2"),
      }),
    ).rejects.toThrow("Expert identity conflict");
    await expect(
      service.resolve({
        executionId: "execution",
        invocationId: "runtime-collision",
        parentInvocationId: "root",
        input: null,
        state: {},
        source: { kind: "flow", flowId: "flow", stepId: "review", visit: 3 },
        owner: fixture.owner,
        expert: fixture.expert,
        runtimeId: "other-runtime",
        resolver: fixed("context-2"),
      }),
    ).rejects.toThrow("Runtime identity conflict");
    await expect(
      service.resolve({
        executionId: "execution",
        invocationId: "owner-collision",
        parentInvocationId: "root",
        input: null,
        state: {},
        source: { kind: "flow", flowId: "flow", stepId: "review", visit: 3 },
        owner: { type: "flow-execution", ownerId: "other-execution" },
        expert: fixture.expert,
        runtimeId: "runtime",
        resolver: fixed("context-2"),
      }),
    ).rejects.toThrow("owner conflict");
  });

  it("requires immutable Runtime identity and valid Session provenance", () => {
    const now = new Date().toISOString();
    const base = {
      schemaVersion: "pragma.runtime-context/v2",
      contextId: "root",
      owner: { type: "expert-session", ownerId: "session" },
      origin: { type: "expert-session", sessionId: "session" },
      expert: { id: "expert", version: "1.0.0" },
      runtimeId: "runtime",
      lifecycle: "open",
      createdAt: now,
      updatedAt: now,
    };

    expect(RuntimeContextRecordSchema.safeParse(base).success).toBe(true);
    expect(
      RuntimeContextRecordSchema.safeParse({
        ...base,
        origin: { type: "expert-session", sessionId: "other-session" },
      }).success,
    ).toBe(false);
    expect(RuntimeContextRecordSchema.safeParse({ ...base, runtimeId: undefined }).success).toBe(
      false,
    );
  });

  it("rejects Runtime Context identity mutation patches instead of ignoring them", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.store.commit({
        commitId: "mutate-context-origin",
        executionId: "execution",
        contextPatches: [
          {
            contextId: "context-2",
            patch: { origin: { type: "invocation", invocationId: "replacement" } },
          },
        ],
      }),
    ).rejects.toThrow("Runtime Context identity cannot change");
    await expect(fixture.store.getContext("execution", "context-2")).resolves.toMatchObject({
      origin: { type: "invocation", invocationId: "second" },
    });
  });
});

async function createFixture(options: { readonly closeFirst?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "pragma-context-resolution-"));
  const store = createFileExecutionStore({ pragmaHome: home });
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 1).toISOString();
  const owner = { type: "flow-execution" as const, ownerId: "execution" };
  const expert = { id: "expert", version: "1.0.0" };
  await store.create(
    {
      schemaVersion: "pragma.execution/v5",
      executionId: "execution",
      version: 0,
      kind: "flow",
      definition: { id: "flow", version: "1.0.0", kind: "flow" },
      rootInvocationId: "root",
      status: "running",
      input: null,
      state: {},
      lastAppliedSequence: 0,
      createdAt: now,
      updatedAt: now,
    },
    invocation("root", "root", now),
  );
  const contexts: RuntimeContextRecord[] = [
    contextRecord("context-1", "first", now, owner, expert, options.closeFirst === true),
    contextRecord("context-2", "second", later, owner, expert, false),
  ];
  await store.commit({
    commitId: "history",
    executionId: "execution",
    contextPuts: contexts,
    invocationPuts: [
      invocation("first", "context-1", now, "review"),
      invocation("second", "context-2", later, "review"),
    ],
  });
  return { store, owner, expert };
}

function invocation(
  invocationId: string,
  contextId: string,
  createdAt: string,
  nodeId?: string,
): Invocation {
  return {
    invocationId,
    rootInvocationId: "root",
    ...(invocationId === "root" ? {} : { parentInvocationId: "root" }),
    ...(nodeId === undefined ? {} : { nodeId }),
    definition: {
      id: nodeId === undefined ? "flow" : "expert",
      version: "1.0.0",
      kind: nodeId === undefined ? "flow" : "expert",
    },
    contextId,
    status: invocationId === "root" ? "running" : "succeeded",
    input: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function contextRecord(
  contextId: string,
  invocationId: string,
  createdAt: string,
  owner: { readonly type: "flow-execution"; readonly ownerId: string },
  expert: { readonly id: string; readonly version: string },
  closed: boolean,
): RuntimeContextRecord {
  return {
    schemaVersion: "pragma.runtime-context/v2",
    contextId,
    owner,
    origin: { type: "invocation", invocationId },
    expert,
    runtimeId: "runtime",
    lifecycle: closed ? "closed" : "open",
    ...(closed ? { closedAt: createdAt } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

function resolutionContext() {
  return {
    source: { kind: "flow" as const, flowId: "flow", stepId: "step", visit: 1 },
    executionId: "execution",
    owner: { type: "flow-execution" as const, ownerId: "execution" },
    target: { expertId: "expert", expertVersion: "1.0.0", runtimeId: "runtime" },
    invocation: { input: null },
    state: {},
    previousContexts: [],
    freshContextId: "fresh",
  };
}
