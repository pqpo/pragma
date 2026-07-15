import { describe, expect, it } from "vitest";

import type { PragmaFlowResource } from "@pragma/interpreter/ast";
import { visualFlowUnsupportedReason } from "./PragmaResourceDirectoryFragment.tsx";

describe("visualFlowUnsupportedReason", () => {
  it("keeps advanced route transitions out of the lossy visual editor", () => {
    const flow = flowFixture();
    flow.spec.graph.transitions["review"] = {
      route: "decision",
      cases: { approved: { goto: "finish" }, rejected: { fail: "Rejected" } },
      fallback: { end: true },
    };

    expect(visualFlowUnsupportedReason(flow)).toContain("more expressive");
  });

  it("accepts the bounded repeat-or-end subset emitted by the visual editor", () => {
    const flow = flowFixture();
    flow.spec.graph.loops = { review_loop: { entry: "review", maxIterations: 3 } };
    flow.spec.graph.transitions["review"] = {
      route: "approved",
      cases: { false: { repeat: { loop: "review_loop", goto: "review" } } },
      fallback: { end: true },
    };

    expect(visualFlowUnsupportedReason(flow)).toBeUndefined();
  });
});

function flowFixture(): PragmaFlowResource {
  return {
    apiVersion: "pragma/v1",
    kind: "Flow",
    metadata: {
      id: "review",
      version: "1.0.0",
      name: "Review",
      description: "Review a change",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "review",
        steps: {
          review: {
            human: { kind: "approval", prompt: "Approve?" },
            version: "2.0.0",
          },
          finish: {
            human: { kind: "approval", prompt: "Finish?" },
            version: "1.0.0",
          },
        },
        loops: {},
        transitions: { review: { goto: "finish" }, finish: { end: true } },
      },
    },
  };
}
