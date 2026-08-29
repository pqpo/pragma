import { InMemoryContextStore, error, ok } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { DynamicContextStore } from "./dynamic-context-store.ts";

describe("DynamicContextStore", () => {
  it("makes a store created after Invocation assembly writable without replacing the router", async () => {
    const state: { active?: InMemoryContextStore } = {};
    const router = new DynamicContextStore(async () =>
      state.active === undefined
        ? error("store_unavailable", "Start a revision first.")
        : ok(state.active),
    );

    await expect(router.listContext({})).resolves.toMatchObject({
      ok: false,
      error: { code: "store_unavailable" },
    });

    state.active = new InMemoryContextStore();
    await expect(
      router.addContext({
        id: "items/runtime-binding.md",
        content: "# Runtime binding\n",
        metadata: { trigger: "model_decision", priority: "normal" },
      }),
    ).resolves.toMatchObject({ ok: true, value: { id: "items/runtime-binding.md" } });
    await expect(router.readContext({ id: "items/runtime-binding.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: "# Runtime binding\n" },
    });
  });
});
