import type { AgentInstance, RuntimeContextRecord } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { createAgentLauncher } from "../src/agent/agent-launcher.ts";
import type { Expert } from "../src/agent/expert-agent.ts";
import {
  ExpertOrchestrator,
  type ExpertInteractionAccess,
} from "../src/execution/expert-orchestrator.ts";
import type { ExecutionStore } from "../src/execution/execution-store.ts";

describe("list_agents pagination", () => {
  it("continues short and legacy cursors through the actual tool with a long Context ID", async () => {
    const contextIds = ["custom-" + "x".repeat(1_000), "context-two", "context-three"];
    const contexts = contextIds.map(
      (contextId, index) =>
        ({
          contextId,
          expert: { id: "worker" },
          lifecycle: "open",
          createdAt: `2026-09-14T00:00:0${index}.000Z`,
        }) as RuntimeContextRecord,
    );
    const agents = contextIds.map(
      (contextId, index) =>
        ({
          agentId: `agent-${index}`,
          executionId: "execution",
          contextId,
          ownerContextId: "owner",
          lifecycle: "open",
          createdAt: contexts[index]!.createdAt,
        }) as AgentInstance,
    );
    const store = {
      listContexts: async () => contexts,
      listInvocations: async () => [],
      listAgents: async () => agents,
    } as unknown as ExecutionStore;
    const orchestrator = new ExpertOrchestrator({
      executionId: "execution",
      rootInvocationId: "root",
      scopeInvocationId: "root",
      store,
      maxConcurrency: 1,
      maxDepth: 1,
      interruptController: {
        interruptInvocation: async () => false,
        signalForInvocation: () => new AbortController().signal,
        steerInvocation: async () => "unsupported",
      },
      execute: async () => undefined,
    });
    const access: ExpertInteractionAccess = {
      ownerContextId: "owner",
      callerInvocationId: "root",
      callerDepth: 0,
      spawnExpertIds: new Set(),
      interactExpertIds: new Set(),
      isCoordinator: true,
    };
    const expert = { id: "worker", name: "Worker", description: "Test worker" } as Expert;
    const list = createAgentLauncher({ experts: [expert] }).tools.find(
      (candidate) => candidate.name === "list_agents",
    )!;
    const call = async (input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly status?: string;
    }) =>
      await list.call(input, undefined, {
        execution: {
          executionId: "execution",
          invocationId: "root",
          depth: 0,
          listAgents: async (request) => await orchestrator.list(access, request),
        },
      });

    const first = await call({ limit: 1 });
    expect(first.isError).not.toBe(true);
    const firstPage = first.details as {
      contexts: readonly { contextId: string }[];
      nextCursor: string;
    };
    expect(firstPage.contexts.map((item) => item.contextId)).toEqual([contextIds[0]]);
    expect(firstPage.nextCursor).toMatch(/^a1\.[A-Za-z0-9_-]{22}$/u);
    expect(firstPage.nextCursor.length).toBeLessThanOrEqual(64);

    const second = await call({ cursor: firstPage.nextCursor, limit: 1 });
    expect(
      (second.details as { contexts: readonly { contextId: string }[] }).contexts.map(
        (item) => item.contextId,
      ),
    ).toEqual([contextIds[1]]);
    const legacy = await call({ cursor: contextIds[0]!, limit: 1 });
    expect(legacy.details).toEqual(second.details);
    expect(await call({ cursor: firstPage.nextCursor, status: "resumable" })).toMatchObject({
      isError: true,
    });
  });
});
