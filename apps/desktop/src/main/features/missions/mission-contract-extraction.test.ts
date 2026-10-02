import { readFile } from "node:fs/promises";

import {
  MissionContextMountsSchema as SharedMissionContextMountsSchema,
  MissionExecutionBindingSchema,
  MissionIdSchema as SharedMissionIdSchema,
  MissionModelOverrideSchema as SharedMissionModelOverrideSchema,
  MissionWorkspaceSchema as SharedMissionWorkspaceSchema,
  ToolPermissionModeSchema,
} from "@pragma/shared";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { ExpertModelConfigSchema } from "../../../shared/contracts/capabilities.ts";
import {
  MissionIdSchema,
  MissionModelOverrideSchema,
  MissionWorkspaceSchema,
} from "../../../shared/contracts/mission-base.ts";
import {
  MissionBaseSchema,
  MissionContextMountsSchema,
  MissionContextMountV10Schema,
  MissionSchema,
} from "../../../shared/contracts/missions.ts";
import { DesktopToolPermissionModeSchema } from "../../../shared/contracts/settings.ts";

const fixtureRoot = "./fixtures/";

describe("Mission neutral contract extraction", () => {
  it("keeps Desktop and Local Host on the same wire value validators", () => {
    expect(MissionIdSchema).toBe(SharedMissionIdSchema);
    expect(MissionWorkspaceSchema).toBe(SharedMissionWorkspaceSchema);
    expect(MissionModelOverrideSchema).toBe(SharedMissionModelOverrideSchema);
    expect(MissionContextMountsSchema).toBe(SharedMissionContextMountsSchema);
    expect(MissionBaseSchema.shape.execution.unwrap()).toBe(MissionExecutionBindingSchema);
    expect(DesktopToolPermissionModeSchema).toBe(ToolPermissionModeSchema);
  });

  it.each(["mission-v8.yaml", "mission-v9.yaml"])(
    "retains neutral values accepted from the real historical %s fixture",
    async (file) => {
      const historical = parse(
        await readFile(new URL(`${fixtureRoot}${file}`, import.meta.url), "utf8"),
      ) as Record<string, unknown>;
      const base = MissionBaseSchema.parse(historical);
      expect(base).toEqual({
        id: historical.id,
        title: historical.title,
        goal: historical.goal,
        initialMessageId: historical.initialMessageId,
        toolPermissionMode: historical.toolPermissionMode,
        workspace: historical.workspace,
        project: historical.project,
        executor: historical.executor,
        lifecycleStatus: historical.lifecycleStatus,
        createdAt: historical.createdAt,
        updatedAt: historical.updatedAt,
      });
      expect(
        MissionSchema.parse({ ...base, schemaVersion: "pragma.mission/v11", contextMounts: [] }),
      ).toEqual({
        ...base,
        schemaVersion: "pragma.mission/v11",
        origin: { type: "user" },
        contextMounts: [],
      });
    },
  );

  it("preserves the previous model override accepted values and parsed output", () => {
    const previous = ExpertModelConfigSchema.omit({ runtimeId: true }).strict();
    for (const input of [
      { providerId: " provider ", modelId: " model ", thinkingLevel: " high " },
      { providerId: "p".repeat(200), modelId: "m".repeat(200) },
      { providerId: "provider", modelId: "model" },
      { providerId: "provider", modelId: "model", runtimeId: "pi" },
      { providerId: "provider", modelId: " " },
      { providerId: "provider", modelId: "model", thinkingLevel: "" },
    ]) {
      const before = previous.safeParse(input);
      const after = MissionModelOverrideSchema.safeParse(input);
      expect(after.success).toBe(before.success);
      if (before.success && after.success) expect(after.data).toEqual(before.data);
    }
  });

  it("keeps the historical v10 mount reader closed to later mount kinds", () => {
    expect(
      MissionContextMountV10Schema.safeParse({
        kind: "skill-revision-draft",
        draftId: "10000000-0000-4000-8000-000000000001",
        revisionJobId: "10000000-0000-4000-8000-000000000001",
        capabilityId: "7k2m9q4v8np6r3dt",
      }).success,
    ).toBe(false);
  });
});
