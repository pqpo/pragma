import { afterEach, describe, expect, it, vi } from "vitest";

import { PragmaPaths } from "@pragma/core";
import { PragmaAutomationResourceSchema } from "@pragma/interpreter/ast";

import { previewScheduleOccurrences } from "./automation-schedule.ts";
import { automationMissionInput, createAutomationService } from "./automation-service.ts";
import {
  createAutomationBinding,
  type AutomationState,
  type AutomationStore,
} from "./automation-store.ts";
import type { MissionCreator } from "../missions/mission-creator.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("Automation Schedules", () => {
  it("previews fixed intervals from the first occurrence after the requested time", () => {
    const occurrences = previewScheduleOccurrences(
      {
        kind: "interval",
        every: 2,
        unit: "hours",
        anchorAt: "2026-07-23T00:00:00.000Z",
      },
      new Date("2026-07-23T03:00:00.000Z"),
      3,
    );

    expect(occurrences.map((value) => value.toISOString())).toEqual([
      "2026-07-23T04:00:00.000Z",
      "2026-07-23T06:00:00.000Z",
      "2026-07-23T08:00:00.000Z",
    ]);
  });

  it("applies IANA time zones to calendar schedules", () => {
    const occurrences = previewScheduleOccurrences(
      {
        kind: "calendar",
        frequency: "weekdays",
        time: "09:00",
        timezone: "Asia/Shanghai",
      },
      new Date("2026-07-23T02:00:00.000Z"),
      2,
    );

    expect(occurrences.map((value) => value.toISOString())).toEqual([
      "2026-07-24T01:00:00.000Z",
      "2026-07-27T01:00:00.000Z",
    ]);
  });

  it("respects active windows and rejects invalid time zones", () => {
    expect(
      previewScheduleOccurrences(
        {
          kind: "cron",
          expression: "0 * * * *",
          timezone: "UTC",
          window: {
            startsAt: "2026-07-23T02:30:00.000Z",
            endsAt: "2026-07-23T04:30:00.000Z",
          },
        },
        new Date("2026-07-23T00:00:00.000Z"),
        5,
      ).map((value) => value.toISOString()),
    ).toEqual(["2026-07-23T03:00:00.000Z", "2026-07-23T04:00:00.000Z"]);
    expect(() =>
      previewScheduleOccurrences(
        {
          kind: "cron",
          expression: "0 9 * * *",
          timezone: "Mars/Olympus",
        },
        new Date("2026-07-23T00:00:00.000Z"),
      ),
    ).toThrow("Invalid IANA timezone");
  });
});

describe("Automation Service", () => {
  it("can retry startup reconciliation after a project revision is temporarily unavailable", async () => {
    const get = vi
      .fn<PragmaProjectStore["get"]>()
      .mockRejectedValueOnce(new Error("revision unavailable"))
      .mockResolvedValue({
        schemaVersion: "pragma.project-snapshot/v3",
        projectId: "studio",
        revision: 1,
        resources: [],
        diagnostics: [],
      });
    const service = createAutomationService({
      paths: new PragmaPaths({ pragmaHome: "/tmp/pragma-automation-start-retry-test" }),
      project: { get } as unknown as PragmaProjectStore,
      store: {} as AutomationStore,
      missions: {} as MissionStore,
      creator: {} as MissionCreator,
      runner: {} as MissionRunner,
    });

    await expect(service.start()).rejects.toThrow("revision unavailable");
    await expect(service.start()).resolves.toBeUndefined();

    expect(get).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it("maps schema-less Flow prompts through the normal Mission goal input", () => {
    const resource = PragmaAutomationResourceSchema.parse({
      apiVersion: "pragma/v4",
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

  it("queues a manual trigger through the normal Automation event pipeline", async () => {
    const now = new Date("2026-07-23T08:00:00.000Z");
    const resource = PragmaAutomationResourceSchema.parse({
      apiVersion: "pragma/v4",
      kind: "Automation",
      metadata: {
        id: "m9a8n9nxvvyb4j01",
        name: "Manual review",
        description: "Can also be started from its detail page",
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
          executor: { ref: "expert:t9ne4d8njvvxv2ea" },
          input: { kind: "prompt", value: "Review the release." },
        },
        interaction: { mode: "new-mission" },
        delivery: { adapter: "pragma.automation.delivery.local@v1" },
      },
    });
    const ref = "automation:m9a8n9nxvvyb4j01";
    const binding = createAutomationBinding({
      automationRef: ref,
      rotateGeneration: true,
      workspace: { path: "/tmp", basename: "tmp" },
      toolPermissionMode: "request-approval",
    });
    let state: AutomationState = {
      schemaVersion: "pragma.automation-state/v1",
      automationRef: ref,
      generation: binding.generation,
      queue: [],
      runs: [],
      updatedAt: now.toISOString(),
    };
    const store = {
      getBinding: vi.fn(async () => binding),
      getState: vi.fn(async () => state),
      updateState: vi.fn(async (_ref, _generation, update) => {
        state = update(state);
        return state;
      }),
    } as unknown as AutomationStore;
    const service = createAutomationService({
      paths: new PragmaPaths({ pragmaHome: "/tmp/pragma-automation-manual-trigger-test" }),
      project: {
        get: vi.fn(async () => ({
          schemaVersion: "pragma.project-snapshot/v3",
          projectId: "studio",
          revision: 1,
          resources: [resource],
          diagnostics: [],
        })),
      } as unknown as PragmaProjectStore,
      store,
      missions: {
        get: vi.fn(async () => await new Promise<never>(() => undefined)),
      } as unknown as MissionStore,
      creator: {} as MissionCreator,
      runner: {} as MissionRunner,
      now: () => now,
    });

    await service.start();
    const summary = await service.trigger(ref);

    expect(summary.queueDepth).toBe(1);
    expect(state.queue[0]).toMatchObject({
      scheduledFor: now.toISOString(),
      createdAt: now.toISOString(),
    });
    expect(state.queue[0]?.eventId).toMatch(/^manual:/);
    expect(state.runs[0]).toMatchObject({
      eventId: state.queue[0]?.eventId,
      status: "queued",
    });
    service.stop();
  });
});
