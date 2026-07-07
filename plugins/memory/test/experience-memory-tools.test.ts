import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemorySystem,
  createExperienceMemoryTools,
  createFileSystemExperienceMemoryStore,
} from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("experience-memory tools", () => {
  it("appends experience memory using workflow defaults", async () => {
    const dir = await mkdtemp(join(process.cwd(), "tmp-experience-tool-memory-"));
    tempDirs.push(dir);
    const memorySystem = new MemorySystem({
      experienceStore: createFileSystemExperienceMemoryStore({
        agentId: "code-search-agent",
        filePath: join(dir, "experience.json"),
      }),
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
