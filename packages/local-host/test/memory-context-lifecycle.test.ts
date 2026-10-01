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
