import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationsRoot = join(dirname(fileURLToPath(import.meta.url)), "../src/storage/migrations");

describe("state migration directory layout", () => {
  it("keeps every adjacent step backed by immutable schemas and a static family index", async () => {
    const families = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();

    expect(families).toEqual(
      expect.arrayContaining([
        "execution",
        "execution-transaction",
        "expert-session",
        "expert-session-transaction",
        "runtime-session",
      ]),
    );

    for (const family of families) {
      const familyRoot = join(migrationsRoot, family);
      const familyEntries = await readdir(familyRoot);
      expect(familyEntries).toContain("index.ts");
      expect(familyEntries).toContain("schemas");

      const schemas = new Set(await readdir(join(familyRoot, "schemas")));
      expect([...schemas].every((file) => /^v[1-9][0-9]*\.ts$/u.test(file))).toBe(true);

      if (!familyEntries.includes("steps")) continue;
      const index = await readFile(join(familyRoot, "index.ts"), "utf8");
      for (const stepFile of await readdir(join(familyRoot, "steps"))) {
        const match = /^v([1-9][0-9]*)-to-v([1-9][0-9]*)\.ts$/u.exec(stepFile);
        expect(match, `${family}/${stepFile} must use vN-to-vN+1.ts`).not.toBeNull();
        const fromVersion = Number(match?.[1]);
        const toVersion = Number(match?.[2]);
        expect(toVersion).toBe(fromVersion + 1);
        expect(schemas).toContain(`v${fromVersion}.ts`);
        expect(schemas).toContain(`v${toVersion}.ts`);
        expect(index).toContain(`./steps/${stepFile}`);
      }
    }
  });
});
