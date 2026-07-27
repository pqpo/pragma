import { describe, expect, it } from "vitest";

import type { ExpertDefinition } from "../../../../shared/contracts/index.ts";
import {
  isBuiltInExpert,
  toCreateExpertInput,
  toExpertRecord,
  toPersistedInput,
} from "./studio-model.ts";

const persistedExpert: ExpertDefinition = {
  schemaVersion: "pragma.desktop-expert-view/v1",
  ref: "expert:3sfd30h5017wd17d",
  id: "reviewer",
  name: "Reviewer",
  description: "Reviews changes.",
  tags: [],
  scope: "Reviews code quality. Does not merge changes.",
  instructions: "Review changes carefully.",
  additionalInstructions: "",
  origin: "project",
  readOnly: false,
  customized: false,
  executionProfile: {
    mode: "pinned",
    model: { runtimeId: "test", providerId: "test", modelId: "test" },
  },
  resourceRuntime: { ref: "runtime-profile:t1sp06tbv5846g6t" },
  capabilities: [],
  toolApprovals: {},
  plugins: [],
  contextStoreMounts: [],
  resourceTools: [],
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("toPersistedInput", () => {
  it("persists context store mounts edited on an existing expert record", () => {
    const record = {
      ...toExpertRecord(persistedExpert),
      contextStoreMounts: [
        {
          storeId: "240ac3d2-2dfa-46a6-b568-03f2a29c2bed",
          enabled: true,
          priority: 0,
        },
      ],
    };

    expect(toPersistedInput(record).contextStoreMounts).toEqual(record.contextStoreMounts);
    expect(toPersistedInput(record)).toMatchObject({ baseRevision: persistedExpert.revision });
  });

  it("creates a new object against its captured project revision and source ref", () => {
    const record = toExpertRecord(persistedExpert);

    expect(
      toCreateExpertInput(record, {
        baseRevision: 4,
        requiredUnchangedRefs: [persistedExpert.ref],
      }),
    ).toMatchObject({
      baseRevision: 4,
      requiredUnchangedRefs: [persistedExpert.ref],
    });
  });
});

describe("isBuiltInExpert", () => {
  it("uses explicit origin metadata", () => {
    expect(isBuiltInExpert({ origin: "built-in", readOnly: true })).toBe(true);
    expect(isBuiltInExpert({ origin: "project", readOnly: false })).toBe(false);
  });
});
