import { describe, expect, it } from "vitest";

import {
  ContextOutputService,
  ContextSystem,
  InMemoryContextStore,
  unwrapInvocationOutput,
} from "../src/index.ts";

describe("ContextOutputService", () => {
  it("keeps small output inline", async () => {
    const service = new ContextOutputService("execution-1", new ContextSystem());
    const output = await service.normalize("invocation-1", "context-1", "small");
    expect(output).toEqual({ type: "inline", value: "small" });
    expect(unwrapInvocationOutput(output)).toBe("small");
  });

  it("writes large output through the configured Context overflow target", async () => {
    const store = new InMemoryContextStore();
    const contexts = new ContextSystem();
    expect(
      contexts.register({
        namespace: "board",
        store,
        overflowTarget: true,
        mutationApproval: "none",
      }).ok,
    ).toBe(true);
    const service = new ContextOutputService("execution-1", contexts, { inlineLimitBytes: 4 });
    const output = await service.normalize("invocation-1", "context-1", "large output");
    expect(output.type).toBe("context");
    if (output.type !== "context") return;
    expect(output.contexts[0]?.namespace).toBe("board");
    const stored = await contexts.read({ namespace: "board", id: output.contexts[0]!.id });
    expect(stored.ok && stored.value.content).toBe("large output");
  });

  it("fails closed for large output without an overflow target", async () => {
    const service = new ContextOutputService("execution-1", new ContextSystem(), {
      inlineLimitBytes: 4,
    });
    await expect(service.normalize("invocation-1", "context-1", "large output")).rejects.toThrow(
      "overflow target",
    );
  });

  it("rejects multiple overflow targets", () => {
    const contexts = new ContextSystem();
    expect(
      contexts.register({
        namespace: "one",
        store: new InMemoryContextStore(),
        overflowTarget: true,
      }).ok,
    ).toBe(true);
    const second = contexts.register({
      namespace: "two",
      store: new InMemoryContextStore(),
      overflowTarget: true,
    });
    expect(second.ok ? undefined : second.error.code).toBe("invalid_input");
  });
});
