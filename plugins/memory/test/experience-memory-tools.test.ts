import { describe, expect, it } from "vitest";

import {
  MemorySystem,
  createExperienceMemoryTools,
  createInMemoryExperienceMemoryStore,
} from "../src/index.ts";

describe("experience-memory tools", () => {
  it("appends experience memory using workflow defaults", async () => {
    const memorySystem = new MemorySystem({
      experienceStore: createInMemoryExperienceMemoryStore(),
    });
    const tools = createExperienceMemoryTools({
      memorySystem,
      defaultAgentId: "code-search-agent",
    });
    const appendTool = tools.find((tool) => tool.name === "append_experience_memory");

    const result = await appendTool?.call(
      {
        scope: "session",
        kind: "tool",
        content: "Searched packages/core/src/loop for runtime code.",
        status: "summarized",
      },
      undefined,
      {
        runContext: {
          source: {
            type: "workflow",
            id: "code-search-agent",
          },
          attributes: {
            "execution.workflowRunId": "workflow-1",
          },
        },
      },
    );

    expect(result?.text).toContain("Appended experience memory:");

    const listed = await memorySystem.listExperiences({
      workflowRunId: "workflow-1",
    });
    expect(listed).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({
          content: "Searched packages/core/src/loop for runtime code.",
        }),
      ],
    });
  });
});
