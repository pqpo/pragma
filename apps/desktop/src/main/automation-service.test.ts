import { afterEach, describe, expect, it, vi } from "vitest";

import { PragmaPaths } from "@pragma/core";
import { PragmaAutomationResourceSchema } from "@pragma/interpreter/ast";

import type { AutomationBinding, Mission } from "../shared/desktop-api.ts";
import { automationMissionInput, createAutomationService } from "./automation-service.ts";
import type { AutomationState, AutomationStore } from "./automation-store.ts";
import type { MissionCreator } from "./mission-creator.ts";
import type { MissionRunner } from "./mission-runner.ts";
import type { MissionStore } from "./mission-store.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("AutomationService", () => {
  it("maps schema-less Flow prompts through the normal Mission goal input", () => {
    const resource = PragmaAutomationResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "Automation",
      metadata: {
        id: "m9a8n9nxvvyb4j01",
        name: "Flow review",
        description: "Starts a review Flow",
        tags: [],
      },
      spec: {
        adapter: "pragma.automation.schedule@v1",
        binding: "binding:desktop-automation",
        config: {
          trigger: {
            kind: "calendar",
            frequency: "daily",
            time: "09:00",
            timezone: "UTC",
          },
        },
        enabled: true,
        route: {
          executor: { ref: "flow:t9ne4d8njvvxv2ea" },
          input: { kind: "prompt", value: "Review the release." },
        },
        interaction: { mode: "new-mission" },
        delivery: { adapter: "pragma.automation.delivery.local@v1" },
      },
    });

    expect(automationMissionInput(resource)).toEqual({
      kind: "auto",
      value: "Review the release.",
    });
  });

  it("serializes overlapping reusable events into one Mission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
    const resource = PragmaAutomationResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "Automation",
      metadata: {
        id: "e0a62t5kw81ngc03",
        name: "Frequent review",
        description: "Review every minute",
        tags: [],
      },
      spec: {
        adapter: "pragma.automation.schedule@v1",
        binding: "binding:desktop-automation",
        config: {
          trigger: {
            kind: "interval",
            every: 1,
            unit: "minutes",
            anchorAt: "2026-07-23T00:00:00.000Z",
          },
        },
        enabled: true,
        route: {
          executor: { ref: "expert:3sfd30h5017wd17d" },
          input: { kind: "prompt", value: "Review now." },
        },
        interaction: { mode: "reuse-session" },
        delivery: { adapter: "pragma.automation.delivery.local@v1" },
      },
    });
    const binding: AutomationBinding = {
      schemaVersion: "pragma.automation-binding/v2",
      automationRef: "automation:e0a62t5kw81ngc03",
      revision: 1,
      generation: "57c6dcff-f3b7-40d3-ae29-9b6a6d2ef40b",
      workspace: { path: "/work/review", basename: "review" },
      placement: "desktop",
      toolPermissionMode: "request-approval",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    let state: AutomationState = {
      schemaVersion: "pragma.automation-state/v1",
      automationRef: binding.automationRef,
      generation: binding.generation,
      queue: [],
      runs: [],
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    const missions = new Map<string, Mission>();
    let finishFirst!: () => void;
    const firstExecution = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const run = vi.fn(async (id: string) => {
      missions.set(id, {
        ...missions.get(id)!,
        execution: {
          id: "87ec1f30-2c8c-4a63-a789-8fded1c3b60e",
          inputMessageId: "90621093-b59f-40ce-82d6-767303433f06",
          status: "running",
          startedAt: new Date().toISOString(),
        },
      });
      await firstExecution;
      const completed = {
        ...missions.get(id)!,
        execution: {
          ...missions.get(id)!.execution!,
          status: "succeeded" as const,
          finishedAt: new Date().toISOString(),
        },
      };
      missions.set(id, completed);
      return completed;
    });
    const sendMessage = vi.fn(async ({ id }: { readonly id: string }) => missions.get(id)!);
    const service = createAutomationService({
      paths: new PragmaPaths({ pragmaHome: "/tmp/pragma-automation-service-test" }),
      project: {
        get: async () => ({
          schemaVersion: "pragma.desktop-project-snapshot/v1",
          projectId: "studio",
          revision: 1,
          resources: [resource],
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as PragmaProjectStore,
      store: {
        getBinding: async () => binding,
        saveBinding: async (value) => value,
        getState: async () => structuredClone(state),
        updateState: async (_ref, _generation, update) => {
          state = { ...update(structuredClone(state)), updatedAt: new Date().toISOString() };
          return structuredClone(state);
        },
        remove: async () => undefined,
      } satisfies AutomationStore,
      missions: {
        get: async (id: string) => missions.get(id)!,
      } as unknown as MissionStore,
      creator: {
        create: async (input) => {
          const mission = {
            id: input.id!,
            lifecycleStatus: "active",
          } as Mission;
          missions.set(mission.id, mission);
          return mission;
        },
      } satisfies MissionCreator,
      runner: {
        run,
        sendMessage,
      } as unknown as MissionRunner,
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();

    expect(run).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.queue).toHaveLength(1);

    finishFirst();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Review now.", id: state.missionId }),
    );
    expect(state.queue).toHaveLength(0);
    expect(state.runs.map((record) => record.status)).toEqual(["dispatched", "dispatched"]);
    service.stop();
  });

  it("starts a new reusable Mission when the previous Mission completes while waiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
    const resource = PragmaAutomationResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "Automation",
      metadata: {
        id: "smnt16qvwbsb3s2b",
        name: "Reusable review",
        description: "Review every minute",
        tags: [],
      },
      spec: {
        adapter: "pragma.automation.schedule@v1",
        binding: "binding:desktop-automation",
        config: {
          trigger: {
            kind: "interval",
            every: 1,
            unit: "minutes",
            anchorAt: "2026-07-23T00:00:00.000Z",
          },
        },
        enabled: true,
        route: {
          executor: { ref: "expert:3sfd30h5017wd17d" },
          input: { kind: "prompt", value: "Review now." },
        },
        interaction: { mode: "reuse-session" },
        delivery: { adapter: "pragma.automation.delivery.local@v1" },
      },
    });
    const binding: AutomationBinding = {
      schemaVersion: "pragma.automation-binding/v2",
      automationRef: "automation:smnt16qvwbsb3s2b",
      revision: 1,
      generation: "57c6dcff-f3b7-40d3-ae29-9b6a6d2ef40b",
      workspace: { path: "/work/review", basename: "review" },
      placement: "desktop",
      toolPermissionMode: "request-approval",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    const previousMissionId = "00000000-0000-4000-8000-000000000001";
    const eventMissionId = "00000000-0000-4000-8000-000000000002";
    let state: AutomationState = {
      schemaVersion: "pragma.automation-state/v1",
      automationRef: binding.automationRef,
      generation: binding.generation,
      missionId: previousMissionId,
      queue: [
        {
          eventId: "schedule:event",
          scheduledFor: "2026-07-23T00:00:00.000Z",
          missionId: eventMissionId,
          createdAt: "2026-07-23T00:00:00.000Z",
        },
      ],
      runs: [],
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    const missions = new Map<string, Mission>([
      [
        previousMissionId,
        {
          id: previousMissionId,
          lifecycleStatus: "active",
          execution: {
            id: "87ec1f30-2c8c-4a63-a789-8fded1c3b60e",
            inputMessageId: "90621093-b59f-40ce-82d6-767303433f06",
            status: "running",
            startedAt: "2026-07-23T00:00:00.000Z",
          },
        } as Mission,
      ],
    ]);
    const create = vi.fn(async (input: Parameters<MissionCreator["create"]>[0]) => {
      const mission = { id: input.id!, lifecycleStatus: "active" } as Mission;
      missions.set(mission.id, mission);
      return mission;
    });
    const run = vi.fn(async (id: string) => missions.get(id)!);
    const sendMessage = vi.fn(async ({ id }: { readonly id: string }) => missions.get(id)!);
    const service = createAutomationService({
      paths: new PragmaPaths({ pragmaHome: "/tmp/pragma-automation-service-race-test" }),
      project: {
        get: async () => ({
          schemaVersion: "pragma.desktop-project-snapshot/v1",
          projectId: "studio",
          revision: 1,
          resources: [resource],
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as PragmaProjectStore,
      store: {
        getBinding: async () => binding,
        saveBinding: async (value) => value,
        getState: async () => structuredClone(state),
        updateState: async (_ref, _generation, update) => {
          state = { ...update(structuredClone(state)), updatedAt: new Date().toISOString() };
          return structuredClone(state);
        },
        remove: async () => undefined,
      } satisfies AutomationStore,
      missions: {
        get: async (id: string) => missions.get(id)!,
      } as unknown as MissionStore,
      creator: { create },
      runner: { run, sendMessage } as unknown as MissionRunner,
    });

    await service.start();
    await flushPromises();
    missions.set(previousMissionId, {
      ...missions.get(previousMissionId)!,
      lifecycleStatus: "completed",
      completedAt: "2026-07-23T00:00:01.000Z",
      execution: {
        ...missions.get(previousMissionId)!.execution!,
        status: "succeeded",
        finishedAt: "2026-07-23T00:00:01.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(eventMissionId));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: eventMissionId }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.missionId).toBe(eventMissionId);
    expect(state.queue).toHaveLength(0);
    service.stop();
  });
});

async function flushPromises(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}
