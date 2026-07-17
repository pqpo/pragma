import { describe, expect, it } from "vitest";

import type { RuntimeModel } from "@pragma/core";

import {
  createRuntimeTestContextSystem,
  selectRuntimeModel,
  selectRuntimeThinkingLevel,
} from "../src/runtimes/shared/console-runtime-chat.ts";

const models: readonly RuntimeModel[] = [
  {
    id: "model-a",
    displayName: "Model A",
    provider: { kind: "runtime-managed", id: "test", displayName: "Test" },
    default: true,
    thinking: {
      supportedLevels: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      defaultLevel: "low",
    },
  },
  {
    id: "model-b",
    displayName: "Model B",
    provider: { kind: "runtime-managed", id: "test", displayName: "Test" },
  },
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

describe("runtime console thinking-level selection", () => {
  const levels = models[0]?.thinking?.supportedLevels ?? [];

  it("uses the CLI default when the answer is empty", () => {
    expect(selectRuntimeThinkingLevel(levels, "")).toBeUndefined();
  });

  it("selects a discovered thinking level by its displayed number", () => {
    expect(selectRuntimeThinkingLevel(levels, "2")).toEqual({ value: "high", label: "High" });
  });

  it("rejects answers outside the discovered thinking levels", () => {
    expect(() => selectRuntimeThinkingLevel(levels, "3")).toThrow("请输入 1-2");
  });
});

describe("runtime console test context", () => {
  it("mounts always-on, model-decision, and manual content", async () => {
    const contextSystem = createRuntimeTestContextSystem();
    const index = await contextSystem.index();

    expect(index.ok).toBe(true);
    if (!index.ok) return;
    expect(index.value.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runtime-test/always-on.md",
          namespace: "host",
          metadata: expect.objectContaining({ trigger: "always_on" }),
        }),
        expect.objectContaining({
          id: "runtime-test/model-decision.md",
          namespace: "host",
          metadata: expect.objectContaining({ trigger: "model_decision" }),
        }),
        expect.objectContaining({
          id: "runtime-test/verification.md",
          namespace: "host",
          metadata: expect.objectContaining({ trigger: "manual" }),
        }),
      ]),
    );

    const selected = contextSystem.selectContext(index.value.items);
    expect(selected.preload).toEqual([
      expect.objectContaining({
        id: "runtime-test/always-on.md",
        reasons: ["always_on"],
      }),
    ]);
    expect(selected.context).toEqual([
      expect.objectContaining({ id: "runtime-test/model-decision.md" }),
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
