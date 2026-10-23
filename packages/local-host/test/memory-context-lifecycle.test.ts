import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExpertAgentRunContext,
  getExecutionLiveBus,
  withExecutionRunScope,
  type ExpertAgentRunContext,
  type ExecutionStore,
} from "@pragma/core";
import { expect, it, vi } from "vitest";
import type { createLocalHostMemoryDataPlane } from "../src/memory-data-plane.ts";
import type { SecretStore } from "../src/secrets/secret-store.ts";
import { createLocalHostMemoryContextService } from "../src/memory-context.ts";

vi.mock("../src/memory-recall-scope.ts", () => ({
  resolveMemoryRecallScope: async () => ({ rootRefs: [], subjectRefs: [] }),
}));
vi.mock("../src/memory-retrieval.ts", () => ({
  createLocalHostMemoryRetrieval: () => ({
    settings: { get: async () => ({ enabled: true, providerId: "provider", modelId: "model" }) },
    stop: async () => undefined,
  }),
}));
vi.mock("@pragma/memory", async (original) => ({
  ...(await original<typeof import("@pragma/memory")>()),
  createFederatedMemoryContextStore: (
    _registry: unknown,
    options: { resolveRecallScope: (context: ExpertAgentRunContext) => Promise<unknown> },
  ) => ({
    listContext: async ({ context }: { context: ExpertAgentRunContext }) => {
      await options.resolveRecallScope(context);
      return { ok: true, value: [] };
    },
  }),
}));

it.each([false, true])(
  "keeps the new Execution subscription when old replay settles (failure=%s)",
  async (failed) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-memory-generation-"));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readEvents = vi.fn(async () => []);
    readEvents.mockImplementationOnce(async () => {
      await barrier;
      if (failed) throw new Error("Retired replay failed");
      return [];
    });
    const executionStore = { readEvents } as unknown as ExecutionStore;
    const bus = getExecutionLiveBus(executionStore);
    const subscribe = vi.spyOn(bus, "subscribeEvents");
    const onDiagnostic = vi.fn();
    const contexts = createLocalHostMemoryContextService({
      onDiagnostic,
      pragmaHome: root,
      secrets: {} as SecretStore,
      data: {
        setExtractionVectorSearch: vi.fn(),
        executionStore,
        activity: { getExecutionContext: async () => ({ principalRefs: [] }) },
        policies: { getGlobal: async () => ({ policy: { enabled: "enabled" } }) },
      } as unknown as Awaited<ReturnType<typeof createLocalHostMemoryDataPlane>>,
    });
    const binding = { missionId: "mission", goal: "goal" };
    const context = withExecutionRunScope(
      createExpertAgentRunContext({ source: { type: "pragma.expert", id: "expert" } }),
      { executionId: "execution", contextId: "context", invocationId: "invocation" },
    );
    try {
      const old = contexts.createContextStore(binding);
      await old.listContext({ context });
      await vi.waitFor(() => expect(readEvents).toHaveBeenCalledOnce());
      const stopping = contexts.stopMission(binding.missionId);
      const current = contexts.createContextStore({ ...binding });
      await current.listContext({ context });
      expect(subscribe).toHaveBeenCalledTimes(2);
      release();
      await stopping;
      expect(onDiagnostic).not.toHaveBeenCalled();
      await current.listContext({ context });
      expect(subscribe).toHaveBeenCalledTimes(2);
      await contexts.stopMission(binding.missionId);
    } finally {
      release();
      bus.complete("execution");
      await contexts.stop();
      subscribe.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("projects replayed Runtime tool envelopes before Memory attention observes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-tool-observation-"));
  const preview = {
    content: [
      { type: "image", mimeType: "image/png", data: "encoded-media-marker".repeat(200) },
      { type: "text", text: 'task-body-marker {"details":"business-details"}' },
      { type: "resource", resource: { uri: "file:///notes.txt", text: "Useful resource notes" } },
      {
        type: "resource",
        resource: { uri: "file:///data.bin", blob: "encoded-blob-marker".repeat(200) },
      },
      { type: "audio", mimeType: "audio/wav", data: "encoded-audio-marker".repeat(200) },
      { type: "resource_link", uri: "file:///report.pdf", name: "Report" },
    ],
    details: { repeated: "task-body-marker", hostOnly: "host-only-marker" },
  };
  const executionStore = {
    readEvents: async () => [
      {
        type: "runtime.event",
        executionId: "execution",
        invocationId: "invocation",
        data: {
          schemaVersion: "pragma.stream/v1",
          eventId: "event",
          sequence: 1,
          runId: "run",
          emittedAt: new Date().toISOString(),
          source: { kind: "runtime", runId: "run", path: [] },
          type: "tool.completed",
          payload: { toolCallId: "call", toolName: "lookup", kind: "tool", outputPreview: preview },
        },
      },
    ],
    getInvocation: async () => ({
      invocationId: "invocation",
      contextId: "context",
      executorId: "expert",
    }),
    get: async () => ({ definition: { kind: "expert", id: "expert" } }),
  } as unknown as ExecutionStore;
  const bus = getExecutionLiveBus(executionStore);
  const contexts = createLocalHostMemoryContextService({
    pragmaHome: root,
    secrets: {} as SecretStore,
    data: {
      setExtractionVectorSearch: vi.fn(),
      executionStore,
      activity: { getExecutionContext: async () => ({ principalRefs: [] }) },
      policies: { getGlobal: async () => ({ policy: { enabled: "enabled" } }) },
    } as unknown as Awaited<ReturnType<typeof createLocalHostMemoryDataPlane>>,
  });
  const observe = vi.spyOn(contexts.controller, "observe").mockImplementation(() => undefined);
  try {
    const store = contexts.createContextStore({ missionId: "mission", goal: "Find task details" });
    const context = withExecutionRunScope(
      createExpertAgentRunContext({ source: { type: "pragma.expert", id: "expert" } }),
      { executionId: "execution", contextId: "context", invocationId: "invocation" },
    );
    await store.listContext({ context });
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    const input = observe.mock.calls[0]![0];
    expect(input.latestObservation.match(/task-body-marker/g)).toHaveLength(1);
    expect(input.latestObservation).toContain("business-details");
    expect(input.latestObservation).toContain("Useful resource notes");
    expect(input.latestObservation).toContain("file:///report.pdf");
    expect(input.latestObservation).toContain("file:///data.bin");
    expect(input.latestObservation).not.toMatch(
      /host-only-marker|encoded-(media|blob|audio)-marker/,
    );
    expect(preview.details.hostOnly).toBe("host-only-marker");
  } finally {
    bus.complete("execution");
    await contexts.stop();
    observe.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
