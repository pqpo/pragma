import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExpertAgentHumanInteractionHandler, ExpertToolRuntimeState } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import {
  createAntigravityHookRelay,
  decideAntigravityToolUse as decideAntigravityToolUseImpl,
  type AgyPreToolUseInput,
} from "../src/permission-hooks.ts";

const workspace = "/workspace/project";
const mcpServerName = "pragma0123456789abcdef";

function decideAntigravityToolUse(
  options: Omit<Parameters<typeof decideAntigravityToolUseImpl>[0], "mcpServerName">,
) {
  return decideAntigravityToolUseImpl({ ...options, mcpServerName });
}

describe("Antigravity PreToolUse permission bridge", () => {
  it("accepts absolute and file URI identities for the Expert and managed customization roots", async () => {
    const managedCustomizations = "/runtime/session/managed-customizations";
    for (const workspacePaths of [
      ["file:///workspace/project"],
      [managedCustomizations],
      ["file:///workspace/project", "file:///runtime/session/managed-customizations"],
    ]) {
      await expect(
        decideAntigravityToolUse({
          input: input("view_file", { AbsolutePath: "/workspace/project/file.ts" }, workspacePaths),
          workspace,
          allowedWorkspacePaths: [workspace, managedCustomizations],
          permissionMode: "full-access",
          toolRuntimeState: {},
        }),
      ).resolves.toEqual({ decision: "allow" });
    }
  });

  it("rejects relative and non-file workspace identities", async () => {
    for (const reported of ["workspace/project", "https://example.com/workspace"]) {
      await expect(
        decideAntigravityToolUse({
          input: input("view_file", { AbsolutePath: "/workspace/project/file.ts" }, [reported]),
          workspace,
          permissionMode: "full-access",
          toolRuntimeState: {},
        }),
      ).resolves.toMatchObject({
        decision: "deny",
        reason: expect.stringContaining("invalid workspace path"),
      });
    }
  });

  it("fails closed when the CLI reports another workspace", async () => {
    await expect(
      decideAntigravityToolUse({
        input: input("view_file", { AbsolutePath: "/workspace/project/file.ts" }, [
          workspace,
          "/workspace/other",
        ]),
        workspace,
        permissionMode: "full-access",
        toolRuntimeState: {},
      }),
    ).resolves.toEqual({
      decision: "deny",
      reason: "Antigravity hook reported an unexpected additional workspace: /workspace/other.",
    });
  });

  it("allows only the isolated Pragma MCP registration without prompting", async () => {
    await expect(
      decideAntigravityToolUse({
        input: input(`mcp__${mcpServerName}__list_expert_context`, {}),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    await expect(
      decideAntigravityToolUse({
        input: input("mcp", { server: mcpServerName, tool: "list_expert_context" }),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      decideAntigravityToolUse({
        input: input("McpTool", {
          server_name: mcpServerName,
          tool_name: "list_expert_context",
          arguments: {},
        }),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({
      decision: "allow",
      permissionOverrides: [`mcp(${mcpServerName}/list_expert_context)`],
    });
    await expect(
      decideAntigravityToolUse({
        input: input("call_mcp_tool", {
          ServerName: mcpServerName,
          ToolName: "list_expert_context",
          Arguments: {},
        }),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "allow" });

    for (const spoofed of [
      `mcp__${mcpServerName}__suffix__list_expert_context`,
      `mcp_${mcpServerName}_suffix_list_expert_context`,
    ]) {
      await expect(
        decideAntigravityToolUse({
          input: input(spoofed, {}),
          workspace,
          permissionMode: "auto-approve",
          toolRuntimeState: {},
        }),
      ).resolves.toMatchObject({ decision: "deny" });
    }
    await expect(
      decideAntigravityToolUse({
        input: input("call_mcp_tool", {
          ServerName: mcpServerName,
          ToolName: "list_expert_context/*)",
        }),
        workspace,
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny" });

    await expect(
      decideAntigravityToolUse({
        input: input("call_mcp_tool", {
          ServerName: "pragma",
          ToolName: "list_expert_context",
        }),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    await expect(
      decideAntigravityToolUse({
        input: input("pragma__spoofed", {}),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny" });
  });

  it("allows workspace reads and rejects absolute paths outside it", async () => {
    await expect(
      decideAntigravityToolUse({
        input: input("view_file", { AbsolutePath: "/workspace/project/src/index.ts" }),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toEqual({ decision: "allow" });
    await expect(
      decideAntigravityToolUse({
        input: input("view_file", { AbsolutePath: "/etc/passwd" }),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("unsafe workspace file arguments"),
    });
  });

  it("allows only read tools inside the Session-managed Skill root", async () => {
    const managedSkillRoot =
      "/runtime/session/managed-customizations/.agents/plugins/pragma-test/skills";
    await expect(
      decideAntigravityToolUse({
        input: input("view_file", {
          AbsolutePath: `${managedSkillRoot}/review/SKILL.md`,
        }),
        workspace,
        managedSkillReadRoots: [managedSkillRoot],
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toEqual({ decision: "allow" });
    await expect(
      decideAntigravityToolUse({
        input: input("view_file", {
          AbsolutePath: "/runtime/session/managed-customizations/.agents/hooks.json",
        }),
        workspace,
        managedSkillReadRoots: [managedSkillRoot],
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    await expect(
      decideAntigravityToolUse({
        input: input("write_file", {
          TargetFile: `${managedSkillRoot}/review/SKILL.md`,
        }),
        workspace,
        managedSkillReadRoots: [managedSkillRoot],
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny" });
  });

  it("rejects relative traversal and paths that escape through a workspace symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-hook-paths-"));
    const managedWorkspace = join(root, "workspace");
    const outside = join(root, "outside");
    try {
      await Promise.all([mkdir(managedWorkspace), mkdir(outside)]);
      await symlink(
        outside,
        join(managedWorkspace, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(
        decideAntigravityToolUse({
          input: input("view_file", { AbsolutePath: "../outside/secret.txt" }, [managedWorkspace]),
          workspace: managedWorkspace,
          permissionMode: "request-approval",
          toolRuntimeState: {},
        }),
      ).resolves.toMatchObject({ decision: "deny" });
      await expect(
        decideAntigravityToolUse({
          input: input(
            "view_file",
            { AbsolutePath: join(managedWorkspace, "escape", "secret.txt") },
            [managedWorkspace],
          ),
          workspace: managedWorkspace,
          permissionMode: "request-approval",
          toolRuntimeState: {},
        }),
      ).resolves.toMatchObject({ decision: "deny" });
      const approve = vi.fn<ExpertAgentHumanInteractionHandler>().mockResolvedValue({
        kind: "tool_approval",
        approved: true,
      });
      await expect(
        decideAntigravityToolUse({
          input: input(
            "write_file",
            { TargetFile: join(managedWorkspace, "escape", "generated.ts") },
            [managedWorkspace],
          ),
          workspace: managedWorkspace,
          permissionMode: "request-approval",
          humanInteractionHandler: approve,
          toolRuntimeState: {},
        }),
      ).resolves.toMatchObject({ decision: "deny" });
      expect(approve).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps auto-approve bounded to workspace paths but makes full-access explicit", async () => {
    await expect(
      decideAntigravityToolUse({
        input: input("write_file", { TargetFile: "/workspace/project/generated.ts" }),
        workspace,
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toEqual({ decision: "allow" });
    await expect(
      decideAntigravityToolUse({
        input: input("write_file", { TargetFile: "file:///etc/generated.ts" }),
        workspace,
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    for (const target of ["FILE:///etc/generated.ts", "file:/etc/generated.ts"]) {
      await expect(
        decideAntigravityToolUse({
          input: input("write_file", { TargetFile: target }),
          workspace,
          permissionMode: "auto-approve",
          toolRuntimeState: {},
        }),
      ).resolves.toMatchObject({ decision: "deny" });
    }
    await expect(
      decideAntigravityToolUse({
        input: input("write_file", { TargetFile: "/etc/generated.ts" }),
        workspace,
        permissionMode: "full-access",
        toolRuntimeState: {},
      }),
    ).resolves.toEqual({ decision: "allow" });
  });

  it("fails closed for automatic shell, unmanaged MCP, and unknown native tools", async () => {
    await expect(
      decideAntigravityToolUse({
        input: input("run_command", {
          CommandLine: "touch /tmp/pragma-outside-workspace",
          Cwd: workspace,
        }),
        workspace,
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("shell or terminal"),
    });
    await expect(
      decideAntigravityToolUse({
        input: input("mcp__unmanaged__write", { path: "/workspace/project/file.ts" }),
        workspace,
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("managed Pragma MCP"),
    });
    await expect(
      decideAntigravityToolUse({
        input: input("schedule", {}),
        workspace,
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("known workspace file"),
    });
  });

  it("routes side-effecting tools through Core approval and emits the request event", async () => {
    const emitted = vi.fn();
    const handler = vi.fn<ExpertAgentHumanInteractionHandler>().mockResolvedValue({
      kind: "tool_approval",
      approved: true,
    });
    const state = {
      runId: "run-1",
      source: { kind: "runtime", runId: "run-1", path: [] },
      emitter: { emit: emitted },
    } as unknown as ExpertToolRuntimeState;
    const toolInput = input("run_command", { CommandLine: "pnpm test" });

    await expect(
      decideAntigravityToolUse({
        input: toolInput,
        workspace,
        permissionMode: "request-approval",
        humanInteractionHandler: handler,
        toolRuntimeState: state,
      }),
    ).resolves.toEqual({ decision: "allow" });
    expect(handler).toHaveBeenCalledWith({
      kind: "tool_approval",
      toolName: "run_command",
      toolCallId: "agy:conversation-1:4",
      reason: "Antigravity requested a potentially side-effecting tool.",
      input: { CommandLine: "pnpm test" },
    });
    expect(emitted).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool.approval_requested",
        payload: expect.objectContaining({ toolName: "run_command" }),
      }),
    );
  });

  it("denies absent and declined approvals, and applies reproducible shallow input edits", async () => {
    await expect(
      decideAntigravityToolUse({
        input: input("run_command", { CommandLine: "pnpm test" }),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny", reason: expect.stringContaining("no approval") });

    const declined = vi.fn<ExpertAgentHumanInteractionHandler>().mockResolvedValue({
      kind: "tool_approval",
      approved: false,
      reason: "No commands today.",
    });
    await expect(
      decideAntigravityToolUse({
        input: input("run_command", { CommandLine: "pnpm test" }),
        workspace,
        permissionMode: "request-approval",
        humanInteractionHandler: declined,
        toolRuntimeState: {},
      }),
    ).resolves.toEqual({ decision: "deny", reason: "No commands today." });

    const edited = vi.fn<ExpertAgentHumanInteractionHandler>().mockResolvedValue({
      kind: "tool_approval",
      approved: true,
      updatedInput: { CommandLine: "pnpm test --filter safe" },
    });
    await expect(
      decideAntigravityToolUse({
        input: input("run_command", { CommandLine: "pnpm test" }),
        workspace,
        permissionMode: "request-approval",
        humanInteractionHandler: edited,
        toolRuntimeState: {},
      }),
    ).resolves.toEqual({
      decision: "allow",
      overwrite: { CommandLine: "pnpm test --filter safe" },
    });

    const removesField = vi.fn<ExpertAgentHumanInteractionHandler>().mockResolvedValue({
      kind: "tool_approval",
      approved: true,
      updatedInput: { CommandLine: "pnpm test" },
    });
    await expect(
      decideAntigravityToolUse({
        input: input("run_command", { CommandLine: "pnpm test", Cwd: workspace }),
        workspace,
        permissionMode: "request-approval",
        humanInteractionHandler: removesField,
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("safe shallow overwrite"),
    });
  });

  it("contains request-approved file mutations before and after user edits", async () => {
    const approve = vi.fn<ExpertAgentHumanInteractionHandler>().mockResolvedValue({
      kind: "tool_approval",
      approved: true,
    });
    await expect(
      decideAntigravityToolUse({
        input: input("write_file", { TargetFile: "/etc/outside.ts", CodeContent: "x" }),
        workspace,
        permissionMode: "request-approval",
        humanInteractionHandler: approve,
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny", reason: expect.stringContaining("unsafe") });
    expect(approve).not.toHaveBeenCalled();

    const editOutside = vi.fn<ExpertAgentHumanInteractionHandler>().mockResolvedValue({
      kind: "tool_approval",
      approved: true,
      updatedInput: { TargetFile: "/etc/edited.ts", CodeContent: "x" },
    });
    await expect(
      decideAntigravityToolUse({
        input: input("write_file", {
          TargetFile: "/workspace/project/original.ts",
          CodeContent: "x",
        }),
        workspace,
        permissionMode: "request-approval",
        humanInteractionHandler: editOutside,
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny", reason: expect.stringContaining("edited") });

    const editInside = vi.fn<ExpertAgentHumanInteractionHandler>().mockResolvedValue({
      kind: "tool_approval",
      approved: true,
      updatedInput: {
        TargetFile: "/workspace/project/edited.ts",
        CodeContent: "updated",
      },
    });
    await expect(
      decideAntigravityToolUse({
        input: input("write_file", {
          TargetFile: "/workspace/project/original.ts",
          CodeContent: "x",
        }),
        workspace,
        permissionMode: "request-approval",
        humanInteractionHandler: editInside,
        toolRuntimeState: {},
      }),
    ).resolves.toEqual({
      decision: "allow",
      overwrite: {
        TargetFile: "/workspace/project/edited.ts",
        CodeContent: "updated",
      },
    });
  });

  it("fails closed when required file paths are missing or use a non-file URI", async () => {
    for (const args of [{ CodeContent: "x" }, { TargetFile: "https://example.com/out.ts" }]) {
      await expect(
        decideAntigravityToolUse({
          input: input("write_file", args),
          workspace,
          permissionMode: "auto-approve",
          toolRuntimeState: {},
        }),
      ).resolves.toMatchObject({ decision: "deny" });
    }
    await expect(
      decideAntigravityToolUse({
        input: input("view_file", {}),
        workspace,
        permissionMode: "request-approval",
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({ decision: "deny" });
  });

  it.each([
    ["view_file", { AbsolutePath: `${workspace}/file.ts` }],
    ["list_dir", { DirectoryPath: workspace }],
    ["grep_search", { Query: "needle", SearchPath: workspace }],
    ["find_by_name", { Pattern: "*.ts", SearchDirectory: workspace }],
    ["list_permissions", {}],
    ["code_search", { Query: "symbol" }],
    ["read_file", { Target: `${workspace}/file.ts` }],
    ["get_file_info", { AbsolutePath: `${workspace}/file.ts` }],
    ["list_directory", { DirectoryPath: workspace }],
    ["create_directory", { TargetDirectory: `${workspace}/generated` }],
    ["create_file", { TargetFile: `${workspace}/created.ts`, CodeContent: "x" }],
    ["delete_file", { AbsolutePath: `${workspace}/obsolete.ts` }],
    [
      "move_file",
      { SourceFile: `${workspace}/before.ts`, DestinationFile: `${workspace}/after.ts` },
    ],
    [
      "multi_replace_file_content",
      {
        TargetFile: `${workspace}/file.ts`,
        ReplacementChunks: [{ TargetContent: "/etc is content", ReplacementContent: "updated" }],
      },
    ],
    [
      "rename_file",
      { SourcePath: `${workspace}/before.ts`, DestinationPath: `${workspace}/after.ts` },
    ],
    ["edit_file", { TargetFile: `${workspace}/file.ts`, SourceCode: "https://example.com" }],
    [
      "replace_file_content",
      { TargetFile: `${workspace}/file.ts`, TargetContent: "/outside-looking text" },
    ],
    ["write_to_file", { TargetFile: `${workspace}/written.ts`, CodeContent: "x" }],
    ["write_file", { TargetFile: `${workspace}/written.ts`, fileContent: "x" }],
  ] as const)("validates the explicit agy 1.1.11 %s path schema", async (toolName, args) => {
    await expect(
      decideAntigravityToolUse({
        input: input(toolName, args),
        workspace,
        permissionMode: "auto-approve",
        toolRuntimeState: {},
      }),
    ).resolves.toEqual({ decision: "allow" });
  });

  it("fails closed when a known multi-path tool reports a drifted path field", async () => {
    for (const args of [
      { Source: `${workspace}/before.ts`, NewLocation: "/etc/after.ts" },
      { SourceFile: `${workspace}/before.ts`, DestinationFile: "/etc/after.ts" },
    ]) {
      await expect(
        decideAntigravityToolUse({
          input: input("move_file", args),
          workspace,
          permissionMode: "auto-approve",
          toolRuntimeState: {},
        }),
      ).resolves.toMatchObject({ decision: "deny" });
    }
  });

  it("converts Antigravity question tools to Core questions and returns the answer to the agent", async () => {
    const handler = vi.fn<ExpertAgentHumanInteractionHandler>().mockResolvedValue({
      kind: "user_question",
      answered: true,
      answers: { "Choose mode": "Safe" },
    });

    await expect(
      decideAntigravityToolUse({
        input: input("ask_user_question", {
          Questions: [
            {
              Header: "Mode",
              Question: "Choose mode",
              Options: [
                { Label: "Safe", Description: "Use sandbox" },
                { Label: "Open", Description: "Use full access" },
              ],
              MultiSelect: false,
            },
          ],
        }),
        workspace,
        permissionMode: "request-approval",
        humanInteractionHandler: handler,
        toolRuntimeState: {},
      }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining('{"Choose mode":"Safe"}'),
    });
    expect(handler).toHaveBeenCalledWith({
      kind: "user_question",
      toolName: "askUserQuestion",
      toolCallId: "agy:conversation-1:4",
      questions: [
        {
          header: "Mode",
          question: "Choose mode",
          kind: "single_choice",
          options: [
            { label: "Safe", description: "Use sandbox" },
            { label: "Open", description: "Use full access" },
          ],
        },
      ],
    });

    await decideAntigravityToolUse({
      input: input("ask_question", {
        questions: [
          {
            question: "Choose checks",
            options: ["Lint", "Test"],
            is_multi_select: true,
          },
        ],
      }),
      workspace,
      permissionMode: "request-approval",
      humanInteractionHandler: handler,
      toolRuntimeState: {},
    });
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        questions: [
          {
            header: "Antigravity",
            question: "Choose checks",
            kind: "multiple_choice",
            options: [
              { label: "Lint", description: "" },
              { label: "Test", description: "" },
            ],
          },
        ],
      }),
    );
  });

  it("serves an authenticated loopback relay and rejects malformed or unauthenticated calls", async () => {
    const relay = await createAntigravityHookRelay({
      workspace,
      mcpServerName,
      permissionMode: "auto-approve",
      getHumanInteractionHandler: () => undefined,
      toolRuntimeState: {},
    });
    try {
      const unauthenticated = await fetch(relay.url, {
        method: "POST",
        body: JSON.stringify(input("view_file", { AbsolutePath: "/workspace/project/a.ts" })),
      });
      expect(unauthenticated.status).toBe(404);

      const malformed = await fetch(relay.url, {
        method: "POST",
        headers: { authorization: relay.authorization },
        body: "not json",
      });
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toMatchObject({ decision: "deny" });

      const allowed = await fetch(relay.url, {
        method: "POST",
        headers: { authorization: relay.authorization },
        body: JSON.stringify(input("view_file", { AbsolutePath: "/workspace/project/a.ts" })),
      });
      expect(allowed.status).toBe(200);
      await expect(allowed.json()).resolves.toEqual({ decision: "allow" });
    } finally {
      await relay.close();
    }
  });
});

function input(
  name: string,
  args: unknown,
  workspacePaths: readonly string[] = [workspace],
): AgyPreToolUseInput {
  return {
    toolCall: { name, args },
    stepIdx: 4,
    conversationId: "conversation-1",
    workspacePaths: [...workspacePaths],
  };
}
