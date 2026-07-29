import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRuntimeEnvironmentStore } from "./runtime-environment-store.ts";

describe("RuntimeEnvironmentStore", () => {
  it("keeps immutable revisions, an explicit default, and deletion tombstones", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-environments-"));
    const store = createRuntimeEnvironmentStore({ pragmaHome });
    await store.initialize();

    expect(await store.getDefaultRuntimeId()).toBe("pi");
    expect((await store.listHeads()).map((head) => head.entry.runtimeId)).toEqual([
      "pi",
      "codex",
      "claude-code",
      "qodercli",
    ]);

    const original = (await store.getRevision("pi"))!;
    const updated = await store.update({
      expectedRevision: original.revision,
      definition: { ...original.definition, displayName: "PI Updated" },
    });
    expect(updated.revision).toBe(2);
    expect((await store.getRevision("pi", 1))?.definition.displayName).toBe("Built-in Runtime");
    expect((await store.getRevision("pi"))?.definition.displayName).toBe("PI Updated");

    await store.setDefaultRuntimeId("codex");
    const deleted = await store.delete({ runtimeId: "pi", expectedRevision: 2 });
    expect(deleted).toMatchObject({ revision: 3, status: "deleted" });
    await expect(store.delete({ runtimeId: "codex", expectedRevision: 1 })).rejects.toThrow(
      "Set another default",
    );
  });

  it("reconciles newly added built-ins without replacing an existing catalog", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-reconcile-"));
    const original = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [
        definition("pi", "PI Runtime", "pragma.runtime.pi"),
        definition("codex", "Codex", "pragma.runtime.codex"),
      ],
      defaultRuntimeId: "pi",
    });
    await original.initialize();
    await original.setDefaultRuntimeId("codex");

    const reconciled = createRuntimeEnvironmentStore({ pragmaHome });
    await reconciled.initialize();

    expect(await reconciled.getDefaultRuntimeId()).toBe("codex");
    expect((await reconciled.listHeads()).map((head) => head.entry.runtimeId)).toEqual([
      "pi",
      "codex",
      "claude-code",
      "qodercli",
    ]);
    expect((await reconciled.getRevision("qodercli"))?.definition.adapter.id).toBe(
      "pragma.runtime.qodercli",
    );
  });
});

function definition(id: string, displayName: string, adapterId: string) {
  return {
    schemaVersion: "pragma.runtime-environment/v1" as const,
    id,
    adapter: { id: adapterId, version: "v1" },
    displayName,
    origin: "built-in" as const,
    config: {},
  };
}
