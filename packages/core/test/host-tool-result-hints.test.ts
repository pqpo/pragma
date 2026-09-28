import { describe, expect, it, vi } from "vitest";
import {
  ContextSystem,
  StaticContextStore,
  createPragmaLogger,
  defineExpert,
} from "../src/index.ts";
import { executeExecutionTool } from "../src/tools/execution-tools.ts";

describe("Host tool result hints", () => {
  it.each([false, true])(
    "preserves results and tool definitions when observation fails: %s",
    async (fails) => {
      const store = new StaticContextStore([]);
      const observe = vi.fn(async () => {
        if (fails) throw Error("private error");
        return "Historical context is available at memory/mission-attention.md.";
      });
      const observedStore = Object.assign(store, { afterToolResult: observe });
      const system = new ContextSystem({ stores: { memory: observedStore } });
      const expert = await defineExpert({
        id: "host-hints",
        name: "Hints",
        description: "Hints",
        tags: [],
        scope: "test",
        workspace: process.cwd(),
        contextSystem: system,
      });
      const original = { text: "tool output", isError: true, details: { preserved: true } };
      const tool = {
        name: "fixture",
        label: "Fixture",
        description: "Fixture",
        inputSchema: { type: "object" as const },
        call: async () => original,
      };
      const before = JSON.stringify(tool.inputSchema);
      const result = await executeExecutionTool({
        agent: expert,
        tool,
        toolCallId: "call-1",
        args: {},
        signal: undefined,
        state: {},
        logger: createPragmaLogger(undefined, { component: "test" }),
      });
      expect(result).toEqual({
        ...original,
        text: fails
          ? original.text
          : `${original.text}\n\nHistorical context is available at memory/mission-attention.md.`,
      });
      expect(JSON.stringify(tool.inputSchema)).toBe(before);
      expect(observe).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: "call-1", result: original }),
      );
    },
  );
});
