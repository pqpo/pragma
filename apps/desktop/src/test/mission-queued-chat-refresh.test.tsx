import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import {
  AsyncPushQueue,
  createNoopLoggerProvider,
  createStaticRuntimeResolver,
} from "@pragma/core";
import { PRAGMA_DSL_WRITE_API_VERSION, type PragmaExpertResource } from "@pragma/interpreter/ast";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";

import {
  MissionChatUpdateSchema,
  missionExecutorSnapshot,
  type MissionChatUpdate,
} from "../shared/contracts/index.ts";
import {
  applyMissionChatUpdateBatch,
  reconcileMissionChatRefresh,
} from "../renderer/src/pages/missions/mission-conversation-model.ts";
import { conversationFromPage } from "../renderer/src/pages/missions/use-mission-conversation.ts";
import { MissionChatEntryView } from "../renderer/src/pages/missions/mission-chat-presentation.tsx";
import { createPragmaProjectStore } from "../main/features/projects/pragma-project-store.ts";
import { createMissionRunner } from "../main/features/missions/mission-runner.ts";
import { createMissionStore } from "../main/features/missions/mission-store.ts";
import { forwardMissionChatNotification } from "../main/features/missions/mission-renderer-update-forwarder.ts";
import { createCodexQueuePeer } from "../main/features/missions/fixtures/codex-queue-peer.ts";

const qoderSdk = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const runtimeRequire = createRequire(require.resolve("@pragma/runtime-qodercli"));
  return { path: runtimeRequire.resolve("@qoder-ai/qoder-agent-sdk"), query: vi.fn() };
});

vi.mock(qoderSdk.path, async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: qoderSdk.query,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  qoderSdk.query.mockReset();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(kind: "codex" | "qoder") {
  const root = await mkdtemp(join(tmpdir(), "pragma-queued-refresh-"));
  cleanups.push(async () => await rm(root, { recursive: true, force: true }));
  const source = join(root, "empty-runtime-home");
  await mkdir(source);
  const started: string[] = [];
  const finishes = new Map<string, () => void>();
  const appenders = new Map<string, (delta: string) => void>();
  const prompts = ["First turn", "Second turn"];
  const onStart = (prompt: string, finish: () => void, append: (delta: string) => void) => {
    started.push(prompt);
    finishes.set(prompt, finish);
    appenders.set(prompt, append);
  };
  const native = createCodexQueuePeer(prompts, onStart);
  let queryIndex = 0;
  qoderSdk.query.mockImplementation(() => {
    const prompt = prompts[queryIndex++];
    if (prompt === undefined) throw new Error("Unexpected Qoder query");
    const stream = new AsyncPushQueue<Record<string, unknown>>();
    let output = "";
    const append = (delta: string) => {
      output += delta;
      stream.push({
        type: "stream_event",
        session_id: "qoder-session",
        uuid: crypto.randomUUID(),
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta },
        },
      });
    };
    const finish = () => {
      stream.push({
        type: "result",
        subtype: "success",
        session_id: "qoder-session",
        uuid: crypto.randomUUID(),
        result: output,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        permission_denials: [],
        modelUsage: {},
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          cache_read_input_tokens: 0,
          context_usage_ratio: 0,
          iterations: [],
        },
      });
      stream.close();
    };
    append(`answer:${prompt}`);
    onStart(prompt, finish, append);
    return {
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      close: async () => stream.close(),
      interrupt: async () => finish(),
      getContextUsage: async () => ({ contextWindow: { usedPercentage: 0 } }),
    };
  });
  const providerId = kind === "codex" ? "openai" : "qoder";
  const listModels = async () => [
    {
      id: "test-model",
      displayName: "Test Model",
      provider: { kind: "runtime-managed" as const, id: providerId, displayName: providerId },
    },
  ];
  const runtime =
    kind === "codex"
      ? createCodexRuntime({
          descriptor: { id: "test-runtime" },
          spawn: native.spawn,
          env: { CODEX_HOME: source },
          canUse: () => ({ usable: true }),
          listModels,
        })
      : createQoderCliRuntime({
          descriptor: { id: "test-runtime" },
          executablePath: "/controlled/qodercli",
          env: { QODER_CONFIG_DIR: source },
          auth: { type: "access-token", token: "test-token" },
          canUse: () => ({ usable: true }),
          listModels,
        });
  const expert: PragmaExpertResource = {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      name: "Writer",
      description: "Refresh regression",
      tags: [],
      avatarId: "pragma.avatar.expert.default",
    },
    spec: {
      scope: "Writing",
      instructions: "Write concise answers.",
      runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
      capabilities: [],
      contextStores: [],
      plugins: [],
      tools: [],
      toolApprovals: {},
    },
  };
  const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
  const revision = await project.publish({
    expectedRevision: 0,
    resources: [
      expert,
      {
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "RuntimeProfile",
        metadata: {
          id: "rdzgnq05qfqcpqcm",
          name: "Runtime",
          description: "Refresh regression",
          tags: [],
        },
        spec: {
          adapter: "pragma.runtime.profile@v1",
          config: { runtimeId: "test-runtime", providerId, model: "test-model" },
        },
      },
    ],
  });
  const missions = createMissionStore({ missionsPath: join(root, "missions") });
  const mission = await missions.create({
    workspace: { path: root, basename: "workspace" },
    goal: prompts[0]!,
    project: { id: revision.projectId, revision: revision.revision },
    executor: missionExecutorSnapshot(expert),
  });
  const runner = createMissionRunner({
    missions,
    project,
    capabilityStore: {} as Parameters<typeof createMissionRunner>[0]["capabilityStore"],
    capabilityCredentials: {} as Parameters<typeof createMissionRunner>[0]["capabilityCredentials"],
    capabilitiesPath: join(root, "capabilities"),
    pragmaHome: join(root, "state"),
    runtimes: createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "test-runtime",
    }),
    loggerProvider: createNoopLoggerProvider(),
  });
  const updates: MissionChatUpdate[] = [];
  runner.subscribeChat((notification) =>
    forwardMissionChatNotification({
      notification,
      getSender: () => ({
        send: (_channel, value) => updates.push(MissionChatUpdateSchema.parse(value)),
      }),
    }),
  );
  cleanups.push(async () => {
    for (const finish of finishes.values()) finish();
    await runner.stopLocalController(mission.id);
  });
  const pausePage = () => {
    const entered = deferred();
    const release = deferred();
    cleanups.push(async () => release.resolve());
    const read = missions.readTimelinePage.bind(missions);
    vi.spyOn(missions, "readTimelinePage").mockImplementationOnce(async (...args) => {
      const page = await read(...args);
      entered.resolve();
      await release.promise;
      return page;
    });
    const page = runner.getChatPage({ id: mission.id, limit: 100 });
    return { entered: entered.promise, release: release.resolve, page };
  };
  const enqueue = async () =>
    await runner.sendMessage({
      id: mission.id,
      requestId: "00000000-0000-4000-8000-000000000091",
      content: prompts[1]!,
    });
  const secondStarted = async () =>
    await vi.waitFor(() => expect(started).toEqual(prompts), { timeout: 10_000 });
  const finishSecond = async () => {
    finishes.get(prompts[1]!)!();
    await vi.waitFor(
      async () =>
        expect((await missions.get(mission.id)).execution).toMatchObject({
          inputMessageId: "00000000-0000-4000-8000-000000000091",
          status: "succeeded",
        }),
      { timeout: 10_000 },
    );
    await runner.stopLocalController(mission.id);
  };
  return {
    runner,
    missions,
    mission,
    updates,
    started,
    finishes,
    appenders,
    pausePage,
    enqueue,
    secondStarted,
    finishSecond,
  };
}

it("bounds latest-page reads and leaves invalidations pending when every read races", async () => {
  const f = await fixture("codex");
  await f.runner.run(f.mission.id);
  await vi.waitFor(() => expect(f.started).toEqual(["First turn"]), { timeout: 10_000 });
  const read = f.missions.readTimelinePage.bind(f.missions);
  let readCount = 0;
  const queuedIds: string[] = [];
  const clearQueued = async () => {
    for (const requestId of queuedIds.splice(0))
      await f.runner.removeQueuedMessage({ id: f.mission.id, requestId });
  };
  cleanups.push(clearQueued);
  const spy = vi.spyOn(f.missions, "readTimelinePage").mockImplementation(async (...args) => {
    const page = await read(...args);
    readCount += 1;
    f.appenders.get("First turn")!(` chunk${readCount}`);
    const requestId = `00000000-0000-4000-8000-${String(readCount).padStart(12, "0")}`;
    queuedIds.push(requestId);
    await f.runner.sendMessage({
      id: f.mission.id,
      requestId,
      content: `Queued ${readCount}`,
    });
    return page;
  });
  const page = await f.runner.getChatPage({ id: f.mission.id, limit: 100 });
  expect(readCount).toBe(3);
  expect(page.revision).toBeLessThan(f.updates.at(-1)!.revision);
  const reconciled = reconcileMissionChatRefresh(null, conversationFromPage(page, null), f.updates);
  expect(reconciled.needsRefresh).toBe(true);
  expect(reconciled.requiredRefreshRevision).toBe(f.updates.at(-1)!.revision);
  const answer = reconciled.snapshot?.entries.find((entry) => entry.kind === "assistant");
  expect(answer).toMatchObject({ content: "answer:First turn chunk1 chunk2 chunk3" });
  spy.mockRestore();
  const settledPage = await f.runner.getChatPage({ id: f.mission.id, limit: 100 });
  expect(
    reconcileMissionChatRefresh(
      reconciled.snapshot,
      conversationFromPage(settledPage, null),
      reconciled.remaining,
    ).needsRefresh,
  ).toBe(false);
  await clearQueued();
  f.finishes.get("First turn")!();
  await vi.waitFor(
    async () => expect((await f.missions.get(f.mission.id)).execution?.status).toBe("succeeded"),
    { timeout: 10_000 },
  );
  await f.runner.stopLocalController(f.mission.id);
}, 30_000);

it("reads a historical page once even if the live turn changes during the read", async () => {
  const f = await fixture("codex");
  await f.runner.run(f.mission.id);
  await vi.waitFor(() => expect(f.started).toEqual(["First turn"]), { timeout: 10_000 });
  await f.enqueue();
  const read = f.missions.readTimelinePage.bind(f.missions);
  let readCount = 0;
  vi.spyOn(f.missions, "readTimelinePage").mockImplementation(async (...args) => {
    const page = await read(...args);
    if (args[1].beforeSequence !== 100) return page;
    readCount += 1;
    if (readCount === 1) {
      f.finishes.get("First turn")!();
      await f.secondStarted();
    }
    return page;
  });
  const beforeCursor = Buffer.from(
    JSON.stringify({ version: 1, kind: "timeline", beforeSequence: 100 }),
  ).toString("base64url");
  const page = await f.runner.getChatPage({ id: f.mission.id, limit: 100, beforeCursor });
  expect(readCount).toBe(1);
  expect(page.revision).toBeLessThan(f.updates.at(-1)!.revision);
  await f.finishSecond();
}, 30_000);

it.each(["codex", "qoder"] as const)(
  "resynchronizes %s queued output when owner release supersedes the initial page read",
  async (kind) => {
    const f = await fixture(kind);
    const read = f.pausePage();
    const superseded = expect(read.page).rejects.toThrow("superseded by resource release");
    await read.entered;
    await f.runner.run(f.mission.id);
    await vi.waitFor(() => expect(f.started).toEqual(["First turn"]), { timeout: 10_000 });
    await f.enqueue();
    f.finishes.get("First turn")!();
    await f.secondStarted();
    await f.finishSecond();
    read.release();
    await superseded;
    // This fixture releases its owner after both turns. A read from before
    // that release cannot reinstall state; a fresh read hydrates the stream.
    const page = await f.runner.getChatPage({ id: f.mission.id, limit: 100 });
    const reconciled = reconcileMissionChatRefresh(
      null,
      conversationFromPage(page, null),
      f.updates,
    );
    expect(reconciled).toMatchObject({ remaining: [], needsRefresh: false });
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        ...reconciled.snapshot.entries.map((entry) =>
          createElement(MissionChatEntryView, { key: entry.id, entry }),
        ),
      ),
    );
    expect(html).toContain("answer:First turn");
    expect(html).toContain("answer:Second turn");
  },
  30_000,
);

it.each(["codex", "qoder"] as const)(
  "keeps rendering %s queued deltas after an in-flight refresh crosses the turn boundary",
  async (kind) => {
    const f = await fixture(kind);
    await f.runner.run(f.mission.id);
    await vi.waitFor(() => expect(f.started).toEqual(["First turn"]), { timeout: 10_000 });
    await f.enqueue();
    const read = f.pausePage();
    await read.entered;
    f.finishes.get("First turn")!();
    await f.secondStarted();
    await vi.waitFor(
      () =>
        expect(
          f.updates.some(
            (update) =>
              update.kind === "patch" &&
              JSON.stringify(update.patches).includes("answer:Second turn"),
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    read.release();
    const page = await read.page;
    let current = reconcileMissionChatRefresh(
      null,
      conversationFromPage(page, null),
      f.updates,
    ).snapshot;
    const html = () =>
      renderToStaticMarkup(
        createElement(
          "div",
          null,
          ...current.entries.map((entry) =>
            createElement(MissionChatEntryView, { key: entry.id, entry }),
          ),
        ),
      );
    expect(html()).toContain("answer:Second turn");
    f.appenders.get("Second turn")!(" still streaming");
    await vi.waitFor(
      () =>
        expect(
          f.updates.some(
            (update) =>
              update.kind === "patch" &&
              JSON.stringify(update.patches).includes(" still streaming"),
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    const applied = applyMissionChatUpdateBatch(current, f.updates);
    expect(applied.needsRefresh).toBe(false);
    current = applied.snapshot;
    expect(html()).toContain("answer:Second turn still streaming");
    await f.finishSecond();
  },
  30_000,
);
