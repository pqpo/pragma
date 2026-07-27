import type { PragmaFlowResource, PragmaResource } from "@pragma/interpreter/ast";

export function runtimeResources(): PragmaResource[] {
  return [
    {
      apiVersion: "pragma/v3",
      kind: "RuntimeProfile",
      metadata: {
        id: "rdzgnq05qfqcpqcm",
        name: "Writer Runtime",
        description: "Writer Runtime",
        tags: ["desktop-managed"],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: {
          runtimeId: "codex-local",
          providerId: "openai",
          model: "gpt-5.6",
        },
      },
    },
    {
      apiVersion: "pragma/v3",
      kind: "Expert",
      metadata: {
        id: "1xddvess309a6gme",
        name: "Writer",
        description: "Writes.",
        tags: [],
      },
      spec: {
        scope: "Write.",
        instructions: "Write.",
        runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [],
        plugins: [],
        tools: [],
      },
    },
  ];
}

export function flowFixture(): PragmaFlowResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Flow",
    metadata: {
      id: "qj3t30sa520dvfvj",
      name: "Review flow",
      description: "Review a change",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "review",
        steps: {
          review: {
            expert: { ref: "expert:t9ne4d8njvvxv2ea" },
            prompt: { segments: [{ text: "Review this change." }] },
          },
        },
        loops: {},
        transitions: { review: { end: true } },
      },
    },
  };
}
