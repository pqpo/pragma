import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JsonContextStore, StaticContextStore } from "../src/index.ts";

describe("JsonContextStore", () => {
  it("persists mutations across instances and enforces optimistic revisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-json-context-"));
    const path = join(directory, "contexts.json");
    const first = new JsonContextStore({ filePath: path });
    const added = await first.addContext({
      id: "rules",
      content: "Prefer explicit boundaries.",
      metadata: { trigger: "always_on", priority: "high" },
    });
    expect(added.ok).toBe(true);

    const second = new JsonContextStore({ filePath: path });
    const read = await second.readContext({ id: "rules" });
    expect(read).toMatchObject({ ok: true, value: { content: "Prefer explicit boundaries." } });
    if (!read.ok) throw new Error(read.error.message);
    await expect(
      second.editContext({
        id: "rules",
        mode: "replace",
        content: "Updated.",
        expectedRevision: "stale",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_conflict" } });
    await expect(
      second.editContext({
        id: "rules",
        mode: "replace",
        content: "Updated.",
        expectedRevision: read.value.revision,
      }),
    ).resolves.toMatchObject({ ok: true, value: { content: "Updated." } });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: "pragma.context-json-store/v1",
      revision: 2,
    });
    await expect(
      second.searchContext({ query: "Updated", scope: "content", maxResults: 10 }),
    ).resolves.toMatchObject({ ok: true, value: [expect.objectContaining({ id: "rules" })] });
    await expect(second.deleteContext({ id: "rules" })).resolves.toEqual({
      ok: true,
      value: { id: "rules" },
    });
  });

  it("enforces byte limits and etag concurrency", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-json-context-"));
    const store = new JsonContextStore({
      filePath: join(directory, "contexts.json"),
      maxContextBytes: 4,
    });
    await expect(
      store.addContext({
        id: "large",
        content: "12345",
        metadata: { trigger: "manual", priority: "normal" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_too_large" } });
    const added = await store.addContext({
      id: "small",
      content: "1234",
      metadata: { trigger: "manual", priority: "normal" },
    });
    if (!added.ok) throw new Error(added.error.message);
    await expect(
      store.editContext({
        id: "small",
        mode: "replace",
        content: "123",
        expectedEtag: "stale",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_conflict" } });
  });

  it("prepends and appends content with explicit separators and optimistic concurrency", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-json-context-"));
    const store = new JsonContextStore({
      filePath: join(directory, "contexts.json"),
      maxContextBytes: 16,
    });
    const added = await store.addContext({
      id: "notes",
      content: "body",
      metadata: { trigger: "manual", priority: "high" },
    });
    if (!added.ok) throw new Error(added.error.message);

    const started = await store.editContext({
      id: "notes",
      mode: "prepend",
      content: "head-",
      separator: "none",
      expectedRevision: added.value.revision,
    });
    expect(started).toMatchObject({
      ok: true,
      value: {
        content: "head-body",
        mode: "prepend",
        metadata: { trigger: "manual", priority: "high" },
      },
    });
    if (!started.ok) throw new Error(started.error.message);

    await expect(
      store.editContext({
        id: "notes",
        mode: "append",
        content: "-stale",
        separator: "newline",
        expectedEtag: added.value.etag,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_conflict" } });

    await expect(
      store.editContext({
        id: "notes",
        mode: "append",
        content: "-tail",
        separator: "blank_line",
        expectedEtag: started.value.etag,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { content: "head-body\n\n-tail", mode: "append" },
    });

    await expect(
      store.editContext({
        id: "notes",
        mode: "append",
        content: "-overflow",
        separator: "none",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_too_large" } });
  });

  it("serializes concurrent writers and never overwrites corrupt JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-json-context-"));
    const path = join(directory, "contexts.json");
    const stores = [
      new JsonContextStore({ filePath: path }),
      new JsonContextStore({ filePath: path }),
    ];
    await Promise.all(
      stores.map(
        async (store, index) =>
          await store.addContext({
            id: `item-${index}`,
            content: String(index),
            metadata: { trigger: "manual", priority: "normal" },
          }),
      ),
    );
    const listed = await stores[0]!.listContext({});
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value.map((item) => item.id).toSorted()).toEqual(["item-0", "item-1"]);

    await writeFile(path, "{broken", "utf8");
    await expect(
      stores[0]!.addContext({
        id: "lost",
        content: "no",
        metadata: { trigger: "manual", priority: "normal" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "store_error" } });
    await expect(readFile(path, "utf8")).resolves.toBe("{broken");
  });
});

describe("StaticContextStore", () => {
  it("supports reads and rejects mutations explicitly", async () => {
    const store = new StaticContextStore([
      { id: "policy", content: "Read only.", metadata: { trigger: "always_on" } },
    ]);
    await expect(store.readContext({ id: "policy" })).resolves.toMatchObject({ ok: true });
    await expect(store.deleteContext({ id: "policy" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
  });
});
