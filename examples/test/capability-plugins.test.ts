import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineExpert } from "@pragma/core";
import { describe, expect, it } from "vitest";

import learningPlugin from "../plugins/learning-plugin/src/plugin.ts";
import toolApprovalPolicy from "../plugins/tool-approval-policy/src/plugin.ts";

describe("capability example plugins", () => {
  it("loads learning-plugin configuration, context, and tool contributions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pragma-learning-plugin-"));
    const expert = await defineExpert({
      id: "learning-plugin-test",
      name: "Learning Plugin Test",
      description: "Learning Plugin Test",
      tags: ["test"],
      version: "1.0.0",
      scope: "test",
      workspace,
      plugins: [
        {
          entry: learningPlugin,
          userConfig: { teamName: "Runtime Team", greetingPrefix: "Hello" },
        },
      ],
    });

    const context = await expert.readContext({
      namespace: "learning-plugin",
      id: "team.md",
    });
    expect(context).toMatchObject({
      ok: true,
      value: { content: expect.stringContaining("Runtime Team") },
    });

    const tool = expert.tools?.find((candidate) => candidate.name === "create_team_greeting");
    expect(tool).toBeDefined();
    await expect(tool?.call({ person: "Ada" }, undefined)).resolves.toMatchObject({
      text: "Hello，Ada！欢迎加入 Runtime Team。",
      details: { teamName: "Runtime Team" },
    });
  });

  it("adds fail-closed approval to the host tool", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pragma-tool-policy-"));
    const expert = await defineExpert({
      id: "tool-policy-test",
      name: "Tool Policy Test",
      description: "Tool Policy Test",
      tags: ["test"],
      version: "1.0.0",
      scope: "test",
      workspace,
      tools: [
        {
          name: "delete_workspace_note",
          description: "Delete a workspace note.",
          inputSchema: {},
          call: async () => ({ text: "deleted" }),
        },
      ],
      plugins: [{ entry: toolApprovalPolicy }],
    });

    const tool = expert.tools?.find((candidate) => candidate.name === "delete_workspace_note");
    expect(tool?.approval?.mode).toBe("required");
    await expect(
      Promise.resolve(
        tool?.approval?.when?.({
          kind: "tool_approval",
          toolName: "delete_workspace_note",
          input: { path: "notes/example.md" },
        }),
      ),
    ).resolves.toBe(true);
  });
});
