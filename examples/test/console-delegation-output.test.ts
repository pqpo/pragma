import type { ExpertTurn } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import {
  parseDelegationStreamMode,
  renderDelegationOutput,
} from "../src/console/console-delegation-output.ts";

type OutputItem = ReturnType<ExpertTurn["getAllOutput"]> extends AsyncIterable<infer TItem>
  ? TItem
  : never;
type Invocation = NonNullable<Awaited<ReturnType<ExpertTurn["getInvocation"]>>>;

describe("delegation console output", () => {
  it("parses main and all stream modes", () => {
    expect(parseDelegationStreamMode([])).toBe("main");
    expect(parseDelegationStreamMode(["--stream=main"])).toBe("main");
    expect(parseDelegationStreamMode(["--stream", "all"])).toBe("all");
    expect(parseDelegationStreamMode(["--", "--stream=all"])).toBe("all");
    expect(() => parseDelegationStreamMode(["--stream=child"])).toThrow(
      'Expected "main" or "all"',
    );
  });

  it("selects the requested output stream and labels every Agent", async () => {
    const rootOutput = vi.fn(() => outputStream([output("root", "message", "main answer")]));
    const allOutput = vi.fn(() =>
      outputStream([
        output("child", "message", "research"),
        output("root", "message", "main answer"),
      ]),
    );
    const turn = {
      result: Promise.resolve("main answer"),
      getRootOutput: rootOutput,
      getAllOutput: allOutput,
      getInvocation: vi.fn(async (invocationId: string) => invocation(invocationId)),
    } as unknown as ExpertTurn;

    const mainText = await render(turn, "main");
    expect(mainText).toContain("[coordinator · answer]\nmain answer");
    expect(mainText).not.toContain("researcher");
    expect(rootOutput).toHaveBeenCalledOnce();

    const allText = await render(turn, "all");
    expect(allText).toContain("[researcher · answer]\nresearch");
    expect(allText).toContain("[coordinator · answer]\nmain answer");
    expect(allOutput).toHaveBeenCalledOnce();
  });
});

async function render(turn: ExpertTurn, mode: "main" | "all"): Promise<string> {
  let text = "";
  await renderDelegationOutput(turn, {
    mode,
    output: { write: (chunk) => (text += chunk) },
  });
  return text;
}

async function* outputStream(items: readonly OutputItem[]) {
  yield* items;
}

function output(
  invocationId: string,
  channel: OutputItem["channel"],
  delta: string,
): OutputItem {
  return {
    sourceEventId: `${invocationId}-${channel}`,
    cursor: { executionId: "execution", sequence: invocationId === "root" ? 2 : 1 },
    executionId: "execution",
    invocationId,
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
    status: "running",
    input: "prompt",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
