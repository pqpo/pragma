import { describe, expect, it } from "vitest";

import {
  END_NODE_ID,
  FAIL_NODE_ID,
  LOGIC_NODE_HEIGHT,
  LOGIC_NODE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  START_NODE_ID,
} from "./flow-canvas-types.ts";

describe("flow-canvas-types", () => {
  it("keeps reserved terminal ids distinct from user nodes", () => {
    expect(new Set([START_NODE_ID, END_NODE_ID, FAIL_NODE_ID])).toHaveLength(3);
    expect(
      [START_NODE_ID, END_NODE_ID, FAIL_NODE_ID].every((id) => id.startsWith("__pragma_canvas_")),
    ).toBe(true);
  });

  it("defines positive layout dimensions for semantic and logic nodes", () => {
    expect([NODE_WIDTH, NODE_HEIGHT, LOGIC_NODE_WIDTH, LOGIC_NODE_HEIGHT]).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    );
    expect(Math.min(NODE_WIDTH, NODE_HEIGHT, LOGIC_NODE_WIDTH, LOGIC_NODE_HEIGHT)).toBeGreaterThan(
      0,
    );
  });
});
