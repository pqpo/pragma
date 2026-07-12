import { describe, expect, it } from "vitest";

import type { RuntimeModel } from "@pragma/core";

import {
  createRuntimeTestContextSystem,
  selectRuntimeModel,
} from "../src/runtimes/shared/console-runtime-chat.ts";

const models: readonly RuntimeModel[] = [
  { id: "model-a", displayName: "Model A", provider: "test", default: true },
  { id: "model-b", displayName: "Model B", provider: "test" },
];

describe("runtime console model selection", () => {
  it("uses the CLI default when the answer is empty", () => {
    expect(selectRuntimeModel(models, "  ")).toBeUndefined();
  });

  it("selects a discovered model by its displayed number", () => {
    expect(selectRuntimeModel(models, "2")).toEqual(models[1]);
  });

  it("rejects answers outside the discovered catalog", () => {
    expect(() => selectRuntimeModel(models, "3")).toThrow("请输入 1-2");
    expect(() => selectRuntimeModel(models, "model-a")).toThrow("请输入 1-2");
  });
});

describe("runtime console test context", () => {
  it("mounts manually loadable verification content", async () => {
    const contextSystem = createRuntimeTestContextSystem();
    const index = await contextSystem.index();

    expect(index.ok).toBe(true);
    if (!index.ok) return;
    expect(index.value.items).toEqual([
      expect.objectContaining({ id: "runtime-test/verification.md", namespace: "host" }),
    ]);

    const context = await contextSystem.read({
      namespace: "host",
      id: "runtime-test/verification.md",
    });
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.value.content).toContain("Verification code: 7319");
    expect(context.value.content).toContain("Release codename: Aurora Finch");
  });
});
