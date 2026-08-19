import { describe, expect, it } from "vitest";

import { InMemoryContextStore, ReadOnlyContextStore } from "../src/index.ts";

describe("ReadOnlyContextStore", () => {
  it("delegates reads and denies every mutation", async () => {
    const source = new InMemoryContextStore({
      context: [{ id: "guide.md", content: "Mission knowledge" }],
    });
    const store = new ReadOnlyContextStore(source);

    await expect(store.listContext()).resolves.toMatchObject({ ok: true });
    await expect(store.readContext({ id: "guide.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: "Mission knowledge" },
    });
    await expect(store.searchContext({ query: "knowledge" })).resolves.toMatchObject({ ok: true });
    await expect(store.addContext({ id: "new.md", content: "blocked" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    await expect(
      store.editContext({ id: "guide.md", mode: "replace", content: "blocked" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
    await expect(store.deleteContext({ id: "guide.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    await expect(source.readContext({ id: "guide.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: "Mission knowledge" },
    });
  });
});
