import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDesktopAdapterHost } from "./mission-adapter-host.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Desktop Pragma adapter Host", () => {
  it("opens a real file Context store at the composition boundary", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pragma-desktop-file-context-"));
    temporaryRoots.push(rootDir);
    await writeFile(join(rootDir, "rules.md"), "# Rules\nKeep boundaries explicit.\n", "utf8");
    const host = createDesktopAdapterHost(
      {} as Parameters<typeof createDesktopAdapterHost>[0],
      rootDir,
    );

    const store = host.openFileContextStore?.({ rootDir });
    await expect(store?.readContext({ id: "rules.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: "# Rules\nKeep boundaries explicit.\n" },
    });
  });
});
