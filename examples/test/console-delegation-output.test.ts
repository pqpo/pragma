import type { ExecutionOutputItem, ExpertTurn } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import {
  parseDelegationStreamMode,
  renderDelegationOutput,
} from "../src/console/console-delegation-output.ts";

type OutputItem = ExecutionOutputItem;
type Invocation = NonNullable<Awaited<ReturnType<ExpertTurn["getInvocation"]>>>;

describe("delegation console output", () => {
  it("parses main and all stream modes", () => {
    expect(parseDelegationStreamMode([])).toEqual({ kind: "root" });
    expect(parseDelegationStreamMode(["--stream=main"])).toEqual({ kind: "root" });
    expect(parseDelegationStreamMode(["--stream", "all"])).toEqual({ kind: "all" });
    expect(parseDelegationStreamMode(["--", "--stream=all"])).toEqual({ kind: "all" });
    expect(parseDelegationStreamMode(["--executor", "researcher"])).toEqual({
      kind: "executor",
      executorId: "researcher",
    });
    expect(() => parseDelegationStreamMode(["--stream=child"])).toThrow('Expected "main" or "all"');
  });

  it("selects the requested output stream and labels every Agent", async () => {
    const subscribeOutput = vi.fn(async ({ scope }: { scope: { kind: string } }) =>
      subscription(
        scope.kind === "root"
          ? [output("root", "message", "main answer")]
          : [
              outputValue("root", "message", {
                role: "assistant",
                content: [{ type: "toolCall", id: "call", name: "delegate", arguments: {} }],
              }),
              output("child", "message", "research"),
              output("root", "message", "main answer"),
            ],
      ),
    );
    const turn = {
      result: Promise.resolve("main answer"),
      subscribeOutput,
      getInvocation: vi.fn(async (invocationId: string) => invocation(invocationId)),
    } as unknown as ExpertTurn;

    const mainText = await render(turn, { kind: "root" });
    expect(mainText).toContain("[coordinator · answer]\nmain answer");
    expect(mainText).not.toContain("researcher");
    expect(subscribeOutput).toHaveBeenCalledWith({ scope: { kind: "root" } });

    const allText = await render(turn, { kind: "all" });
    expect(allText).toContain("[researcher · answer]\nresearch");
    expect(allText).toContain("[coordinator · answer]\nmain answer");
    expect(allText).not.toContain("toolCall");
    expect(subscribeOutput).toHaveBeenCalledWith({ scope: { kind: "all" } });
  });
});

async function render(turn: ExpertTurn, mode: { readonly kind: "root" | "all" }): Promise<string> {
  let text = "";
  await renderDelegationOutput(turn, {
    mode,
    output: { write: (chunk) => (text += chunk) },
  });
  return text;
}

function outputValue(
  invocationId: string,
  channel: OutputItem["channel"],
  value: unknown,
): OutputItem {
  return {
    ...output(invocationId, channel, ""),
    delta: undefined,
    value,
  };
}

function subscription(items: readonly OutputItem[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
    close: async () => undefined,
  };
}

function output(invocationId: string, channel: OutputItem["channel"], delta: string): OutputItem {
  return {
    sourceEventId: `${invocationId}-${channel}`,
    cursor: { executionId: "execution", sequence: invocationId === "root" ? 2 : 1 },
    executionId: "execution",
    invocationId,
    executorId: invocationId === "root" ? "coordinator" : "researcher",
    contextId: `${invocationId}-context`,
    channel,
    delta,
    occurredAt: new Date().toISOString(),
  };
}

function invocation(invocationId: string): Invocation {
  return {
    invocationId,
    rootInvocationId: "root",
    definition: { id: invocationId, version: "1.0.0", kind: "expert" },
    executorId: invocationId === "root" ? "coordinator" : "researcher",
    contextId: `${invocationId}-context`,
    status: "running",
    input: "prompt",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
