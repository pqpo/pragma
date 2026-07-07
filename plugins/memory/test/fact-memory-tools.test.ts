import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemorySystem,
  createFactMemoryTools,
  createFileSystemFactMemoryStore,
} from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("fact-memory tools", () => {
  it("does not expose summary as a writable tool input", () => {
    const tools = createFactMemoryTools({
      memorySystem: new MemorySystem(),
      defaultAgentId: "code-search-agent",
    });
    const writeTool = tools.find((tool) => tool.name === "write_fact_memory");
    const updateTool = tools.find((tool) => tool.name === "update_fact_memory");

    expect(writeTool?.inputSchema).toEqual(
      expect.not.objectContaining({
        properties: expect.objectContaining({
          summary: expect.anything(),
        }),
      }),
    );
    expect(updateTool?.inputSchema).toEqual(
      expect.not.objectContaining({
        properties: expect.objectContaining({
          summary: expect.anything(),
        }),
      }),
    );
  });

  it("writes and lists fact memory through tools", async () => {
    const dir = await mkdtemp(join(process.cwd(), "tmp-fact-tool-memory-"));
    tempDirs.push(dir);
    const memorySystem = new MemorySystem({
      factStore: createFileSystemFactMemoryStore({
        agentId: "code-search-agent",
        filePath: join(dir, "fact.json"),
      }),
    });
    const tools = createFactMemoryTools({
      memorySystem,
      defaultAgentId: "code-search-agent",
    });
    const writeTool = tools.find((tool) => tool.name === "write_fact_memory");
    const listTool = tools.find((tool) => tool.name === "list_fact_memory");

    const writeResult = await writeTool?.call(
      {
        scope: "workspace",
        statement: "@pragma/core loop code lives under packages/core/src/loop.",
        confidence: "high",
        observedAt: "2026-07-06T00:00:00.000Z",
        tags: ["codebase"],
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

    expect(writeResult?.text).toContain("Wrote fact memory:");

    const listResult = await listTool?.call(
      {
        scope: "workspace",
        confidenceAtLeast: "high",
        onlyActive: true,
        tags: ["codebase"],
      },
      undefined,
    );

    expect(listResult?.details).toEqual({
      entries: [
        expect.objectContaining({
          statement: "@pragma/core loop code lives under packages/core/src/loop.",
        }),
      ],
    });
  });
});
