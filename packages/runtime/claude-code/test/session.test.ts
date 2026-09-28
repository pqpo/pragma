import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  askUserQuestionsToCreateRequest,
  applyAskElicitationResponse,
} from "@agentclientprotocol/claude-agent-acp/dist/elicitation.js";
import { describe, expect, it, vi } from "vitest";
import {
  approveClaudeAcpTool,
  answerClaudeAcpForm,
  claudeAdditionalArgs,
  filterClaudeRuntimeEnv,
} from "../src/session.ts";

const permission: RequestPermissionRequest = {
  sessionId: "owned",
  toolCall: {
    toolCallId: "tool",
    title: "Shell",
    rawInput: { command: "echo original" },
    _meta: { claudeCode: { toolName: "Bash" } },
  },
  options: [
    { optionId: "once", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
};
describe("Claude ACP interactions and isolation", () => {
  it("returns Host-approved edits without creating durable permission rules", async () => {
    const handler = vi.fn(async () => ({
      kind: "tool_approval" as const,
      approved: true,
      updatedInput: { command: "echo edited" },
    }));
    await expect(
      approveClaudeAcpTool(permission, handler, new AbortController().signal),
    ).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "once" },
      _meta: { "pragma.updatedInput": { command: "echo edited" } },
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Bash", input: { command: "echo original" } }),
    );
  });
  it("rejects missing handlers and respects cancellation after an approval", async () => {
    const controller = new AbortController();
    await expect(
      approveClaudeAcpTool(permission, undefined, controller.signal),
    ).resolves.toMatchObject({ outcome: { outcome: "cancelled" } });
    await expect(
      approveClaudeAcpTool(
        permission,
        async () => {
          controller.abort();
          return { kind: "tool_approval", approved: true };
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({ outcome: { outcome: "cancelled" } });
  });
  it("sends a denied option for a rejected approval", async () => {
    await expect(
      approveClaudeAcpTool(
        permission,
        async () => ({ kind: "tool_approval", approved: false }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome: { outcome: "selected", optionId: "deny" } });
  });
  it("maps ACP forms into Host questions and maps their keyed answers back", async () => {
    const params: CreateElicitationRequest = {
      mode: "form",
      sessionId: "owned",
      message: "Choose",
      requestedSchema: {
        type: "object",
        properties: {
          question_0: {
            type: "string",
            title: "Direction",
            oneOf: [
              { const: "A", title: "Alpha" },
              { const: "B", title: "Beta" },
            ],
          },
        },
        required: ["question_0"],
      },
    };
    const handler = vi.fn(async () => ({
      kind: "user_question" as const,
      answered: true,
      answers: { question_0: "A" },
    }));
    await expect(
      answerClaudeAcpForm(params, handler, new AbortController().signal),
    ).resolves.toEqual({ action: "accept", content: { question_0: "A" } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [expect.objectContaining({ kind: "single_choice", header: "Direction" })],
      }),
    );
  });
  it("round trips upstream native questions with scoped custom answers", async () => {
    const nativeQuestions: Parameters<typeof askUserQuestionsToCreateRequest>[0] = [
      {
        question: "Which storage?",
        header: "Storage",
        multiSelect: false,
        options: [
          { label: "SQLite", description: "Local" },
          { label: "Postgres", description: "Remote" },
        ],
      },
      {
        question: "Which features?",
        header: "Features",
        multiSelect: true,
        options: [
          { label: "Search", description: "Search" },
          { label: "Sync", description: "Sync" },
        ],
      },
    ];
    const params = askUserQuestionsToCreateRequest(nativeQuestions, "owned", "ask-1");
    const handler = vi
      .fn<import("@pragma/core").ExpertAgentHumanInteractionHandler>()
      .mockResolvedValue({
        kind: "user_question" as const,
        answered: true,
        answers: {
          "Which storage?": "Redis",
          "Which features?": ["Search", "Offline"],
        },
      });
    const response = await answerClaudeAcpForm(params, handler, new AbortController().signal);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      questions: [
        { question: "Which storage?", kind: "single_choice" },
        { question: "Which features?", kind: "multiple_choice" },
      ],
    });
    expect(response).toEqual({
      action: "accept",
      content: {
        question_0_custom: "Redis",
        question_1: ["Search"],
        question_1_custom: "Offline",
      },
    });
    expect(
      applyAskElicitationResponse(response, { questions: nativeQuestions }, nativeQuestions),
    ).toMatchObject({
      action: "answered",
      updatedInput: {
        answers: { "Which storage?": "Redis", "Which features?": "Search, Offline" },
      },
    });
  });
  it("preserves native selected answers with Host notes", async () => {
    const nativeQuestions: Parameters<typeof askUserQuestionsToCreateRequest>[0] = [
      {
        question: "Which storage?",
        header: "Storage",
        multiSelect: false,
        options: [
          { label: "SQLite", description: "Local" },
          { label: "Postgres", description: "Remote" },
        ],
      },
    ];
    const params = askUserQuestionsToCreateRequest(nativeQuestions, "owned", "ask-1");
    const response = await answerClaudeAcpForm(
      params,
      async () => ({
        kind: "user_question",
        answered: true,
        answers: { "Which storage?": "SQLite" },
        notes: "Use WAL",
      }),
      new AbortController().signal,
    );
    expect(applyAskElicitationResponse(response, {}, nativeQuestions)).toMatchObject({
      updatedInput: {
        answers: { "Which storage?": "SQLite" },
        annotations: { "Which storage?": { notes: "Use WAL" } },
      },
    });
  });
  it("maps plain ACP enums and refuses ill-typed or unknown answers", async () => {
    const params: CreateElicitationRequest = {
      mode: "form",
      sessionId: "owned",
      message: "Choose",
      requestedSchema: {
        type: "object",
        properties: { names: { type: "array", items: { type: "string", enum: ["A", "B"] } } },
        required: ["names"],
      },
    };
    const handler = vi
      .fn<import("@pragma/core").ExpertAgentHumanInteractionHandler>()
      .mockResolvedValue({
        kind: "user_question" as const,
        answered: true,
        answers: { Choose: ["B"] },
      });
    await expect(
      answerClaudeAcpForm(params, handler, new AbortController().signal),
    ).resolves.toEqual({ action: "accept", content: { names: ["B"] } });
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      questions: [{ kind: "multiple_choice", options: [{ value: "A" }, { value: "B" }] }],
    });
    await expect(
      answerClaudeAcpForm(
        params,
        async () => ({ kind: "user_question", answered: true, answers: { names: ["unknown"] } }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ action: "cancel" });
  });
  it("cannot override protocol, permission, session or repo-isolation settings", () => {
    for (const flag of [
      "--resume",
      "--settings=host.json",
      "--mcp-config",
      "--bare",
      "--permission-mode",
      "--allowedTools",
      "--add-dir",
      "--system-prompt",
    ])
      expect(() => claudeAdditionalArgs([flag])).toThrow("controlled by Pragma");
    expect(claudeAdditionalArgs(["--max-turns", "3", "--debug"])).toEqual({
      "max-turns": "3",
      debug: null,
    });
  });
  it("removes inherited nested-Claude markers", () => {
    expect(
      filterClaudeRuntimeEnv({
        CLAUDECODE: "1",
        CLAUDECODE_INTERNAL_TOKEN: "private",
        CLAUDECODE_SESSION_ID: "parent-session",
        CLAUDE_CODE_INTERNAL_SECRET: "secret",
        ANTHROPIC_API_KEY: "key",
        PATH: "/bin",
      }),
    ).toEqual({ ANTHROPIC_API_KEY: "key", PATH: "/bin" });
  });
});
