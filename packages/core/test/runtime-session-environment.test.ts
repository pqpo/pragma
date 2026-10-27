import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeContextWindowUsage,
  createRuntimeSessionRecord,
  updateRuntimeSessionRecord,
  defineExpert,
  definePluginEntry,
  defineRuntimeDriver,
  PragmaPaths,
  readRuntimeSessionRecord,
  type ExpertAgentPluginManifest,
  type RuntimeNativeSessionContext,
} from "../src/index.ts";
import {
  rebindRuntimeSessionExpertId,
  restoreRuntimeSessionRecord,
} from "../src/runtime/session-record.ts";
import { fenceOwnerDeletion } from "../src/storage/owner-deletion.ts";
import { ensureLoopbackNoProxy } from "../src/runtime/process-environment.ts";
import { openRuntimeSession } from "../src/runtime/session-factory.ts";
import { createRuntimeTestFeatures } from "../src/testing/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Runtime Session process environment", () => {
  it("retries a managed close failure without repeating native stop or successful destroy hooks", async () => {
    const root = await temporaryRoot();
    const beforeDestroy = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("destroy unavailable"));
    const afterDestroy = vi.fn(async () => {});
    const nativeClose = vi.fn(async () => {});
    const runtime = defineRuntimeDriver<never, Record<string, never>>({
      features: createRuntimeTestFeatures({ enabled: ["close"] }),
      descriptor: { id: "retry-close", kind: "retry-close", displayName: "Retry Close" },
      createSession: () => ({}),
      startTurn: async () => ({ outputText: "" }),
      mapEvent: () => ({ events: [] }),
      closeSession: nativeClose,
    });
    const agent = await defineExpert({
      schemaVersion: "pragma.expert/v1",
      id: "retry-close-expert",
      name: "Retry",
      description: "Retry test",
      tags: ["test"],
      scope: "test",
      workspace: root,
      pragmaHome: root,
      hooks: { beforeSessionDestroy: beforeDestroy, afterSessionDestroy: afterDestroy },
    });
    const session = await openRuntimeSession(runtime, {
      agent,
      owner: { type: "expert-session", ownerId: "retry-owner", contextId: "retry-context" },
      pragmaHome: root,
      systemSessionId: "retry-session",
    });
    await session.stopForDeletion?.();
    await expect(session.close()).rejects.toThrow();
    await session.close();
    await session.close();
    expect(beforeDestroy).toHaveBeenCalledTimes(2);
    expect(afterDestroy).toHaveBeenCalledOnce();
    expect(nativeClose).toHaveBeenCalledOnce();
  });

  it("adds loopback hosts to both proxy bypass variables without dropping existing values", () => {
    const environment = {
      HTTP_PROXY: "http://invalid.proxy.test:8080",
      HTTPS_PROXY: "http://invalid.proxy.test:8080",
      ALL_PROXY: "socks5://invalid.proxy.test:1080",
      NO_PROXY: "example.test, 127.0.0.1",
      no_proxy: "example.test,localhost,::1",
    };

    expect(ensureLoopbackNoProxy(environment)).toEqual({
      ...environment,
      NO_PROXY: "example.test,127.0.0.1,localhost,::1",
      no_proxy: "example.test,127.0.0.1,localhost,::1",
    });
    expect(environment.NO_PROXY).toBe("example.test, 127.0.0.1");
  });

  it("passes loopback proxy bypasses to the shared Runtime child-process environment", async () => {
    const root = await temporaryRoot();
    const captured: Readonly<NodeJS.ProcessEnv>[] = [];
    const runtime = fakeRuntime(captured, {
      HTTP_PROXY: "http://invalid.proxy.test:8080",
      HTTPS_PROXY: "http://invalid.proxy.test:8080",
      ALL_PROXY: "socks5://invalid.proxy.test:1080",
    });
    const agent = await expert(root, "proxy-bypass", "token");
    const session = await open(agent, runtime, "proxy-bypass-session");

    expect(captured[0]).toMatchObject({
      HTTP_PROXY: "http://invalid.proxy.test:8080",
      HTTPS_PROXY: "http://invalid.proxy.test:8080",
      ALL_PROXY: "socks5://invalid.proxy.test:1080",
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    });

    await session.close();
  });

  it("isolates concurrent Expert environment patches without mutating the host", async () => {
    const root = await temporaryRoot();
    const captured: Readonly<NodeJS.ProcessEnv>[] = [];
    const runtime = fakeRuntime(captured);
    const hostValue = process.env["PRAGMA_TEST_SESSION_AUTH"];
    const [firstAgent, secondAgent] = await Promise.all([
      expert(root, "first", "token-a"),
      expert(root, "second", "token-b"),
    ]);

    const [first, second] = await Promise.all([
      open(firstAgent, runtime, "first-session"),
      open(secondAgent, runtime, "second-session"),
    ]);

    expect(captured).toHaveLength(2);
    expect(
      captured.map((environment) => environment["PRAGMA_TEST_SESSION_AUTH"]).toSorted(),
    ).toEqual(["token-a", "token-b"]);
    expect(captured.every((environment) => environment["PRAGMA_TEST_BASE"] === "base")).toBe(true);
    expect(captured.every((environment) => environment["PRAGMA_TEST_REMOVE"] === undefined)).toBe(
      true,
    );
    expect(captured.every(Object.isFrozen)).toBe(true);
    expect(process.env["PRAGMA_TEST_SESSION_AUTH"]).toBe(hostValue);

    await Promise.all([first.close(), second.close()]);
    expect(process.env["PRAGMA_TEST_SESSION_AUTH"]).toBe(hostValue);
  });

  it("fails closed when host and plugin patches claim one variable differently", async () => {
    const root = await temporaryRoot();
    const runtime = fakeRuntime([]);
    const agent = await defineExpert({
      schemaVersion: "pragma.expert/v1",
      id: "conflict",
      name: "Conflict",
      description: "Conflict test",
      tags: ["test"],
      scope: "test",
      workspace: root,
      pragmaHome: root,
      hooks: {
        beforeSessionCreate: () => ({
          processEnvironment: { set: { PRAGMA_TEST_CONFLICT: "host" } },
        }),
      },
      plugins: [
        {
          entry: definePluginEntry({
            manifest: manifest("environment-conflict"),
            setup: () => ({
              hooks: {
                beforeSessionCreate: () => ({
                  processEnvironment: { set: { PRAGMA_TEST_CONFLICT: "plugin" } },
                }),
              },
            }),
          }),
        },
      ],
    });

    await expect(open(agent, runtime, "conflict-session")).rejects.toThrow(
      /Conflicting process environment variable PRAGMA_TEST_CONFLICT/,
    );
  });

  it("persists a native session ID observed before a failed turn", async () => {
    const root = await temporaryRoot();
    const agent = await expert(root, "failed-turn-session-id", "token");
    const nativeSessionId = "11111111-2222-4333-8444-555555555555";
    const runtime = defineRuntimeDriver<{ readonly sessionId: string }, Record<string, never>>({
      features: createRuntimeTestFeatures(),
      descriptor: {
        id: "failed-turn-session-id-runtime",
        kind: "failed-turn-session-id-runtime",
        displayName: "Failed turn Session ID Runtime",
      },
      createSession: () => ({}),
      async startTurn(_session, turn) {
        turn.stream.writeNative({ sessionId: nativeSessionId });
        throw new Error("native turn failed after initialization");
      },
      mapEvent(event) {
        return { events: [], runtimeSessionId: event.sessionId };
      },
    });
    const systemSessionId = "failed-turn-session-id-system";
    const session = await openRuntimeSession(runtime, {
      agent,
      owner: {
        type: "expert-session",
        ownerId: "failed-turn-session-id-owner",
        contextId: "failed-turn-session-id-context",
      },
      pragmaHome: root,
      systemSessionId,
    });

    const submission = session.submit({ query: "fail", execution: {} });
    await expect(submission.result).rejects.toThrow("native turn failed after initialization");
    expect(session.info().runtimeSession).toEqual({
      type: "failed-turn-session-id-runtime",
      id: nativeSessionId,
    });
    await expect(
      readRuntimeSessionRecord(
        new PragmaPaths({ pragmaHome: root }),
        "failed-turn-session-id-owner",
        systemSessionId,
      ),
    ).resolves.toMatchObject({
      runtimeSessionRef: { type: "failed-turn-session-id-runtime", id: nativeSessionId },
    });

    await session.close();
  });
});

describe("Runtime Session context window", () => {
  it.each(["stop first", "usage first", "concurrent"] as const)(
    "merges stale Runtime patches without losing confirmed stop or usage: %s",
    async (order) => {
      const root = await temporaryRoot();
      const paths = new PragmaPaths({ pragmaHome: root });
      const created = await createRuntimeSessionRecord({
        paths,
        owner: { contextId: "race-context", ownerId: "race-owner", type: "expert-session" },
        systemSessionId: "race-session",
        agentId: "race-expert",
        runtime: { id: "race-runtime", kind: "test", displayName: "Race test" },
        workspace: root,
      });
      const running = await updateRuntimeSessionRecord(paths, created, { processState: "running" });
      const runtimeSession = { type: "test", id: "native-id" };
      await updateRuntimeSessionRecord(paths, running, { runtimeSessionRef: runtimeSession });
      await rebindRuntimeSessionExpertId({
        paths,
        ownerId: running.owner.ownerId,
        systemSessionId: running.systemSessionId,
        fromExpertId: "race-expert",
        toExpertId: "replacement-expert",
      });
      await restoreRuntimeSessionRecord({
        paths,
        owner: { contextId: "race-context", ownerId: "race-owner", type: "expert-session" },
        systemSessionId: running.systemSessionId,
        agentId: "replacement-expert",
        runtime: { id: "race-runtime", kind: "test", displayName: "Race test" },
        runtimeSession,
        workspace: join(root, "moved"),
      });
      const usage = createRuntimeContextWindowUsage({
        usedTokens: 12_000,
        contextWindowTokens: 200_000,
        measurement: "reported",
      });
      const stop = () => updateRuntimeSessionRecord(paths, running, { processState: "stopped" });
      const persistUsage = () =>
        updateRuntimeSessionRecord(paths, running, { contextWindowUsage: usage });
      if (order === "concurrent") await Promise.all([stop(), persistUsage()]);
      else if (order === "stop first") {
        await stop();
        await persistUsage();
      } else {
        await persistUsage();
        await stop();
      }
      expect(await readRuntimeSessionRecord(paths, "race-owner", "race-session")).toMatchObject({
        processState: "stopped",
        contextWindowUsage: usage,
        expertId: "replacement-expert",
        runtimeSessionRef: runtimeSession,
        currentWorkspace: join(root, "moved"),
        workspaceHistory: [root, join(root, "moved")],
      });
      await expect(
        updateRuntimeSessionRecord(
          paths,
          { ...running, owner: { ...running.owner, contextId: "wrong-context" } },
          { processState: "failed" },
        ),
      ).rejects.toThrow("Owner mismatch");
      const beforeDeletion = await readRuntimeSessionRecord(paths, "race-owner", "race-session");
      await fenceOwnerDeletion(paths, [running.owner.ownerId]);
      await updateRuntimeSessionRecord(paths, running, { processState: "running" });
      expect(await readRuntimeSessionRecord(paths, "race-owner", "race-session")).toEqual(
        beforeDeletion,
      );
    },
  );

  it("rejects Native restoration after owner deletion without opening the Native session", async () => {
    const root = await temporaryRoot();
    const paths = new PragmaPaths({ pragmaHome: root });
    const captured: Readonly<NodeJS.ProcessEnv>[] = [];
    const runtime = fakeRuntime(captured);
    const agent = await expert(root, "deleted-owner-expert", "token");
    const owner = {
      type: "expert-session" as const,
      ownerId: "deleted-owner",
      contextId: "context",
    };
    const created = await createRuntimeSessionRecord({
      paths,
      owner,
      systemSessionId: "deleted-session",
      agentId: agent.id,
      runtime: runtime.descriptor,
      workspace: root,
    });
    const stopped = await updateRuntimeSessionRecord(paths, created, {
      processState: "stopped",
      runtimeSessionRef: { type: runtime.descriptor.kind, id: "native-session" },
    });
    await fenceOwnerDeletion(paths, [owner.ownerId]);
    await expect(
      openRuntimeSession(runtime, {
        agent,
        owner,
        pragmaHome: root,
        systemSessionId: created.systemSessionId,
        runtimeSession: stopped.runtimeSessionRef!,
      }),
    ).rejects.toThrow("RUNTIME_OWNER_DELETED");
    expect(captured).toEqual([]);
    await expect(
      rebindRuntimeSessionExpertId({
        paths,
        ownerId: owner.ownerId,
        systemSessionId: created.systemSessionId,
        fromExpertId: agent.id,
        toExpertId: "successor-expert",
      }),
    ).rejects.toThrow("RUNTIME_OWNER_DELETED");
    expect(await readRuntimeSessionRecord(paths, owner.ownerId, created.systemSessionId)).toEqual(
      stopped,
    );
  });

  it.each(["succeeds", "fails"] as const)(
    "keeps Native stop confirmed when the cancelled turn later %s with a session ID",
    async (outcome) => {
      const root = await temporaryRoot();
      let finish = () => undefined as void;
      const gate = new Promise<void>((resolve) => (finish = resolve));
      let started = () => undefined as void;
      const starting = new Promise<void>((resolve) => (started = resolve));
      const nativeClose = vi.fn(async () => undefined);
      const runtime = defineRuntimeDriver<{ sessionId: string }, Record<string, never>>({
        features: createRuntimeTestFeatures({ enabled: ["close", "contextWindow"] }),
        descriptor: { id: "late-result", kind: "test", displayName: "Late result" },
        createSession: () => ({}),
        startTurn: async (_native, turn) => {
          started();
          await gate;
          turn.stream.writeNative({ sessionId: "late-native-id" });
          if (outcome === "fails") throw new Error("cancelled turn failed");
          return { outputText: "done", runtimeSessionId: "late-native-id" };
        },
        mapEvent: (event) => ({ events: [], runtimeSessionId: event.sessionId }),
        closeSession: nativeClose,
        readContextWindow: () =>
          createRuntimeContextWindowUsage({
            usedTokens: 12_000,
            contextWindowTokens: 200_000,
            measurement: "reported",
          }),
      });
      const agent = await expert(root, "late-result-expert", "token");
      const session = await open(agent, runtime, "late-result-session");
      try {
        const turn = session.submit({ query: "stop during this turn", execution: {} });
        void turn.result.catch(() => undefined);
        await starting;
        await session.stopForDeletion?.();
        finish();
        if (outcome === "fails") await expect(turn.result).rejects.toThrow("cancelled turn failed");
        else await expect(turn.result).rejects.toThrow("Agent run was cancelled.");
        expect(
          await readRuntimeSessionRecord(
            new PragmaPaths({ pragmaHome: root }),
            "late-result-session",
            "late-result-session",
          ),
        ).toMatchObject({
          processState: "stopped",
          runtimeSessionRef: { type: "test", id: "late-native-id" },
          contextWindowUsage: { usedTokens: 12_000 },
        });
        expect(nativeClose).toHaveBeenCalledOnce();
      } finally {
        finish();
        await session.close();
      }
    },
  );

  it("keeps required capacity inspection but publishes only the settled Runtime baseline", async () => {
    const root = await temporaryRoot();
    const inspect = vi.fn(() =>
      createRuntimeContextWindowUsage({
        usedTokens: 40_000,
        contextWindowTokens: 200_000,
        measurement: "reported",
      }),
    );
    const runtime = defineRuntimeDriver<never, Record<string, never>>({
      features: createRuntimeTestFeatures({ enabled: ["contextWindow"] }),
      descriptor: { id: "context-test", kind: "context-test", displayName: "Context Test" },
      createSession: () => ({}),
      startTurn: async (_session, turn) => {
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "message.delta",
          payload: { contentType: "text", delta: "done" },
        });
        return { outputText: "done" };
      },
      mapEvent: () => ({ events: [] }),
      readContextWindow: inspect,
    });
    const agent = await expert(root, "context-live-expert", "token");
    const session = await open(agent, runtime, "context-live-session");
    const submission = session.submit({ query: "12345678", execution: {} });
    const eventsPromise = (async () => {
      const events = [];
      for await (const event of submission.events) events.push(event);
      return events;
    })();

    await submission.result;
    const events = await eventsPromise;
    const contextUpdates = events.filter((event) => event.type === "context-window.updated");
    const liveUpdate = contextUpdates.find((event) => event.payload.provisional);

    expect(liveUpdate).toBeUndefined();
    expect(contextUpdates.at(-1)?.payload.usage).toMatchObject({
      usedTokens: 40_000,
      measurement: "reported",
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it("persists inspection and compaction snapshots independently of billing usage", async () => {
    const root = await temporaryRoot();
    const inspect = vi.fn(() =>
      createRuntimeContextWindowUsage({
        usedTokens: 40_000,
        contextWindowTokens: 200_000,
        measurement: "reported",
      }),
    );
    const compact = vi.fn(() =>
      createRuntimeContextWindowUsage({
        usedTokens: 12_000,
        contextWindowTokens: 200_000,
        measurement: "reported",
      }),
    );
    const canCompact = vi.fn(() => true);
    const runtime = defineRuntimeDriver<never, Record<string, never>>({
      features: createRuntimeTestFeatures({
        enabled: ["contextWindow", "compaction"],
        compactionModes: ["manual"],
      }),
      descriptor: { id: "context-test", kind: "context-test", displayName: "Context Test" },
      createSession: () => ({}),
      startTurn: async () => ({ outputText: "done" }),
      mapEvent: () => ({ events: [] }),
      readContextWindow: inspect,
      canCompactContext: canCompact,
      compactContext: compact,
    });
    const agent = await expert(root, "context-expert", "token");
    const session = await open(agent, runtime, "context-session");

    await expect(session.contextWindow?.inspect()).resolves.toMatchObject({
      usedTokens: 40_000,
      percent: 20,
    });
    await expect(session.contextWindow?.canCompact()).resolves.toBe(true);
    await expect(session.contextWindow?.compact?.()).resolves.toMatchObject({
      usedTokens: 12_000,
      percent: 6,
    });
    const record = await readRuntimeSessionRecord(
      new PragmaPaths({ pragmaHome: root }),
      "context-session",
      "context-session",
    );
    expect(record.contextWindowUsage).toMatchObject({ usedTokens: 12_000, percent: 6 });
    expect(inspect).toHaveBeenCalledOnce();
    expect(canCompact).toHaveBeenCalledOnce();
    expect(compact).toHaveBeenCalledOnce();
    await session.close();
  });
});

async function expert(root: string, id: string, token: string) {
  return await defineExpert({
    schemaVersion: "pragma.expert/v1",
    id,
    name: id,
    description: "Environment isolation test",
    tags: ["test"],
    scope: "test",
    workspace: root,
    pragmaHome: root,
    hooks: {
      beforeSessionCreate: () => ({
        processEnvironment: {
          set: { PRAGMA_TEST_SESSION_AUTH: token },
          unset: ["PRAGMA_TEST_REMOVE"],
        },
      }),
    },
  });
}

function fakeRuntime(
  captured: Readonly<NodeJS.ProcessEnv>[],
  environment: NodeJS.ProcessEnv = {
    PRAGMA_TEST_BASE: "base",
    PRAGMA_TEST_REMOVE: "remove-me",
  },
) {
  return defineRuntimeDriver<never, { readonly context: RuntimeNativeSessionContext }>(
    {
      features: createRuntimeTestFeatures(),
      descriptor: { id: "environment-test", kind: "environment-test", displayName: "Test" },
      createSession(context) {
        captured.push(context.processEnvironment);
        return { context };
      },
      startTurn: async () => ({ outputText: "" }),
      mapEvent: () => ({ events: [] }),
    },
    {
      createProcessEnvironment: () => environment,
    },
  );
}

async function open(
  agent: Awaited<ReturnType<typeof expert>>,
  runtime: ReturnType<typeof fakeRuntime>,
  id: string,
) {
  return await openRuntimeSession(runtime, {
    agent,
    owner: { type: "expert-session", ownerId: id, contextId: `${id}-context` },
    pragmaHome: agent.workspace,
    systemSessionId: id,
  });
}

function manifest(id: string): ExpertAgentPluginManifest {
  return {
    schemaVersion: "pragma.plugin/v2",
    id,
    name: id,
    description: "Environment test plugin",
    version: "0.0.0",
    tags: ["test"],
    runtime: { type: "expert-agent-plugin", entry: "./index.js", trust: "trusted-host" },
    capabilities: [],
    configuration: { type: "object", properties: {}, additionalProperties: false },
    permissions: { filesystem: [], shell: [], network: [], environment: [] },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-runtime-environment-"));
  roots.push(root);
  return root;
}

it("refuses to label a fixed native adapter with a different permission mode", async () => {
  const { createStaticRuntimeResolver } = await import("../src/runtime-resolver.ts");
  const { defineRuntimeTestDriver } = await import("../src/testing/index.ts");
  const runtime = defineRuntimeTestDriver({
    descriptor: {
      id: "fixed",
      kind: "test",
      displayName: "Fixed",
      configuredPermissionModeId: "full-access",
      permissionModes: {
        defaultModeId: "full-access",
        modes: ["full-access", "read-only"].map((id) => ({
          id,
          label: id,
          description: id,
          available: true,
        })),
      },
    },
    createSession: () => ({}),
    startTurn: () => ({ outputText: "" }),
    mapEvent: () => ({ events: [] }),
  });
  const resolver = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fixed" });
  expect((await resolver.bind()).binding.permissionModeId).toBe("full-access");
  await expect(resolver.bind({ permissionModeId: "read-only" })).rejects.toThrow(
    "configured for full-access",
  );
});
