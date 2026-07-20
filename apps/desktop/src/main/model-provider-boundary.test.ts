import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const RUNTIME_SPECIFIC_IMPORT = /(?:@pragma\/runtime-|@earendil-works\/pi)/;

describe("model provider dependency boundary", () => {
  it("keeps Core contracts and provider storage independent from concrete runtimes", async () => {
    const sources = await Promise.all(
      [
        new URL("./model-provider-store.ts", import.meta.url),
        new URL("../../../../packages/core/src/model-provider/model-provider.ts", import.meta.url),
        new URL(
          "../../../../packages/core/src/model-provider/model-provider-drivers.ts",
          import.meta.url,
        ),
      ].map(async (path) => await readFile(path, "utf8")),
    );

    for (const source of sources) expect(source).not.toMatch(RUNTIME_SPECIFIC_IMPORT);
  });

  it("assembles PI-specific discovery and probing only in the Desktop application", async () => {
    const sources = await Promise.all(
      [
        new URL("./model-connectivity.ts", import.meta.url),
        new URL("./model-discovery.ts", import.meta.url),
      ].map(async (path) => await readFile(path, "utf8")),
    );

    for (const source of sources) expect(source).toMatch(/@pragma\/runtime-pi/);
  });
});
