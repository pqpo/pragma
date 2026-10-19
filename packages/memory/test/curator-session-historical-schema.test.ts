import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CuratorSessionV1Schema } from "../src/storage/migrations/curator-sessions/schemas/v1.ts";
import { CuratorSessionV2Schema } from "../src/storage/migrations/curator-sessions/schemas/v2.ts";

// Historical validation must still load even if the corresponding live protocols disappear.
vi.mock("@pragma/shared", () => {
  throw new Error("Historical Schema must not load current Shared protocols.");
});
vi.mock("../src/storage/bounded-evidence.ts", () => {
  throw new Error("Historical Schema must not load current omission statistics.");
});

describe("frozen Curator dependencies", () => {
  it.each([
    ["v1", CuratorSessionV1Schema],
    ["v2", CuratorSessionV2Schema],
  ] as const)("validates actual %s writer records without live protocols", (version, schema) => {
    const db = new DatabaseSync(
      fileURLToPath(new URL(`./fixtures/curator-sessions/${version}.sqlite`, import.meta.url)),
      { readOnly: true },
    );
    try {
      const rows = db.prepare("SELECT state_json FROM sessions").all() as { state_json: string }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const original = JSON.parse(row.state_json);
        expect(schema.parse(original)).toEqual(original);
        const invalid = structuredClone(original);
        invalid.input.evidence[0].policySnapshot.learning = "future-mode";
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});
