import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineExpert,
  definePluginEntry,
  defineRuntimeDriver,
  createRuntimeContextWindowUsage,
  PragmaPaths,
  readRuntimeSessionRecord,
  type ExpertAgentPluginManifest,
  type RuntimeDriverSessionContext,
} from "../src/index.ts";
import { openRuntimeSession } from "../src/runtime/session-factory.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Runtime Session process environment", () => {
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
});

describe("Runtime Session context window", () => {
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

function fakeRuntime(captured: Readonly<NodeJS.ProcessEnv>[]) {
  return defineRuntimeDriver<never, { readonly context: RuntimeDriverSessionContext }>(
    {
      descriptor: { id: "environment-test", kind: "environment-test", displayName: "Test" },
      createSession(context) {
        captured.push(context.processEnvironment);
        return { context };
      },
      startTurn: async () => ({ outputText: "" }),
      mapEvent: () => ({ events: [] }),
    },
    {
      createProcessEnvironment: () => ({
        PRAGMA_TEST_BASE: "base",
        PRAGMA_TEST_REMOVE: "remove-me",
      }),
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
    pragmaHome: agent.pragmaHome,
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
