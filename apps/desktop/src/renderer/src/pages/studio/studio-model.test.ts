import { describe, expect, it } from "vitest";

import type { ExpertDefinition } from "../../../../shared/desktop-api.ts";
import { toExpertRecord, toPersistedInput } from "./studio-model.ts";

const persistedExpert: ExpertDefinition = {
  schemaVersion: "pragma.expert/v1",
  id: "reviewer",
  name: "Reviewer",
  description: "Reviews changes.",
  tags: [],
  version: "1.0.0",
  scope: "Reviews code quality. Does not merge changes.",
  model: null,
  skills: [],
  mcpServers: [],
  toolIds: [],
  toolApprovals: {},
  plugins: [],
  contextStoreMounts: [],
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
  });
});
