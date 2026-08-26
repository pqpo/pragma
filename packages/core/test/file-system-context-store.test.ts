import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileSystemContextStore } from "../src/index.ts";

describe("FileSystemContextStore", () => {
  it("prepends and appends content with the requested separator", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pragma-file-context-"));
    const store = new FileSystemContextStore({ rootDir });
    const added = await store.addContext({ id: "notes.md", content: "body" });
    if (!added.ok) throw new Error(added.error.message);

    const started = await store.editContext({
      id: "notes.md",
      mode: "prepend",
      content: "head-",
      separator: "newline",
      expectedRevision: added.value.revision,
    });
    expect(started).toMatchObject({
      ok: true,
      value: { content: "head-\nbody", mode: "prepend" },
    });
    if (!started.ok) throw new Error(started.error.message);

    await expect(
      store.editContext({
        id: "notes.md",
        mode: "replace",
        content: "stale",
        expectedRevision: added.value.revision,
        expectedEtag: added.value.etag,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "context_conflict",
        details: {
          expectedRevision: added.value.revision,
          currentRevision: started.value.revision,
          expectedEtag: added.value.etag,
          currentEtag: started.value.etag,
        },
      },
    });

    await expect(
      store.editContext({
        id: "notes.md",
        mode: "append",
        content: "-tail",
        separator: "blank_line",
        expectedEtag: started.value.etag,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { content: "head-\nbody\n\n-tail", mode: "append" },
    });
  });
});
