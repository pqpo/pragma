import { derivePragmaResourceId } from "@pragma/core";
import { describe, expect, it } from "vitest";

import {
  createPragmaResourceIdentityMigrationIndex,
  migrateLegacyPragmaResourceRef,
} from "../src/migrations/index.ts";

describe("Pragma resource identity migration index", () => {
  it("migrates legacy versioned refs through the interpreter resolver", () => {
    expect(migrateLegacyPragmaResourceRef("expert:pragma@1.0.0", "studio")).toBe(
      "expert:0000000000pragma",
    );
    expect(migrateLegacyPragmaResourceRef("flow:release@1.0.0", "studio")).toBe(
      `flow:${derivePragmaResourceId("studio\0Flow\0release")}`,
    );
    expect(migrateLegacyPragmaResourceRef("automation:daily@1.0.0", "studio")).toBe(
      `automation:${derivePragmaResourceId("studio\0Automation\0daily")}`,
    );
    expect(migrateLegacyPragmaResourceRef("expert:current", "studio")).toBe("expert:current");
  });

  it("prefers explicit DSL identity migrations and exposes proof checks", () => {
    const index = createPragmaResourceIdentityMigrationIndex({
      projectId: "studio",
      migrations: [{ kind: "Expert", sourceId: "writer", targetId: "stable_writer" }],
    });

    expect(index.resolveRef("expert:writer@1.0.0")).toBe("expert:stable_writer");
    expect(index.resolveId("Expert", "writer")).toBe("stable_writer");
    expect(index.hasMigration("Expert", "writer", "stable_writer")).toBe(true);
    expect(index.hasMigration("Expert", "reviewer", "stable_writer")).toBe(false);
  });
});
