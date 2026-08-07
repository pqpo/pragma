import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  emitExecutionToolApprovalRequested,
  type ExpertAgentHumanInteractionHandler,
  type ExpertAgentUserQuestion,
  type ExpertToolRuntimeState,
} from "@pragma/core";
import { z } from "zod";

import type { AntigravityRuntimePermissionMode } from "./types.ts";

const MAX_HOOK_BODY_BYTES = 128 * 1024;
const MAX_ANSWER_REASON_CHARACTERS = 8_192;
const READ_ONLY_TOOLS = new Set([
  "view_file",
  "list_dir",
  "grep_search",
  "find_by_name",
  "list_permissions",
  "code_search",
  "read_file",
  "get_file_info",
  "list_directory",
]);
const AUTO_APPROVABLE_WORKSPACE_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  "create_directory",
  "create_file",
  "delete_file",
  "move_file",
  "multi_replace_file_content",
  "rename_file",
  "replace_file_content",
  "write_file",
]);
const TERMINAL_TOOL_NAME = /(?:^|_)(?:command|exec|execute|run|shell|terminal)(?:_|$)/i;

const AgyPreToolUseSchema = z
  .object({
    toolCall: z
      .object({
        name: z.string().min(1),
        args: z.unknown().optional(),
      })
      .passthrough(),
    stepIdx: z.number().int().nonnegative().optional(),
    conversationId: z.string().optional(),
    workspacePaths: z.array(z.string().min(1)).min(1),
    transcriptPath: z.string().optional(),
    artifactDirectoryPath: z.string().optional(),
    modelName: z.string().optional(),
  })
  .passthrough();

export type AgyPreToolUseInput = z.infer<typeof AgyPreToolUseSchema>;

export interface AntigravityHookDecision {
  readonly decision: "allow" | "deny";
  readonly reason?: string | undefined;
  readonly permissionOverrides?: readonly string[] | undefined;
  readonly overwrite?: Readonly<Record<string, unknown>> | undefined;
}

export interface AntigravityHookRelay {
  readonly url: string;
  readonly authorization: string;
  readonly close: () => Promise<void>;
}

export async function createAntigravityHookRelay(options: {
  readonly workspace: string;
  readonly mcpServerName: string;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly getHumanInteractionHandler: () => ExpertAgentHumanInteractionHandler | undefined;
  readonly toolRuntimeState: ExpertToolRuntimeState;
}): Promise<AntigravityHookRelay> {
  const token = randomBytes(32).toString("base64url");
  const authorization = `Bearer ${token}`;
  let closing = false;
  const server = createServer((request, response) => {
    void handleHookRequest({
      request,
      response,
      authorization,
      workspace: resolve(options.workspace),
      mcpServerName: options.mcpServerName,
      permissionMode: options.permissionMode,
      getHumanInteractionHandler: options.getHumanInteractionHandler,
      toolRuntimeState: options.toolRuntimeState,
      isClosing: () => closing,
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Antigravity approval hook relay did not bind a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/pre-tool-use`,
    authorization,
    async close() {
      closing = true;
      server.closeAllConnections?.();
      await closeServer(server);
    },
  };
}

export async function decideAntigravityToolUse(options: {
  readonly input: AgyPreToolUseInput;
  readonly workspace: string;
  readonly mcpServerName: string;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly toolRuntimeState: ExpertToolRuntimeState;
}): Promise<AntigravityHookDecision> {
  const toolName = options.input.toolCall.name;
  const args = options.input.toolCall.args ?? {};
  const workspaceError = await validateWorkspacePaths(
    options.input.workspacePaths,
    options.workspace,
  );
  if (workspaceError !== undefined) {
    return { decision: "deny", reason: workspaceError };
  }
  if (isPragmaMcpTool(toolName, args, options.mcpServerName)) {
    return {
      decision: "allow",
      permissionOverrides: [`mcp(${options.mcpServerName}/*)`],
    };
  }
  if (isAskQuestionTool(toolName)) {
    return await answerAgyQuestion(options, args);
  }
  if (options.permissionMode === "full-access") {
    return { decision: "allow" };
  }
  if (options.permissionMode === "auto-approve") {
    if (isUnmanagedMcpTool(toolName, args, options.mcpServerName)) {
      return {
        decision: "deny",
        reason:
          "Antigravity auto-approve mode only permits the managed Pragma MCP server. Other MCP tools require an explicitly managed Runtime integration.",
      };
    }
    if (isTerminalTool(toolName)) {
      return {
        decision: "deny",
        reason:
          "Antigravity auto-approve mode does not automatically approve native shell or terminal tools. Use request-approval or full-access for command execution.",
      };
    }
    if (!AUTO_APPROVABLE_WORKSPACE_TOOLS.has(toolName)) {
      return {
        decision: "deny",
        reason: `Antigravity auto-approve mode only permits managed MCP tools and known workspace file tools; ${toolName} requires request-approval or full-access.`,
      };
    }
    const outsidePath = await findOutsideWorkspacePath(args, options.workspace);
    return outsidePath === undefined
      ? { decision: "allow" }
      : {
          decision: "deny",
          reason: `Antigravity auto-approve mode blocked a path outside the workspace: ${outsidePath}.`,
        };
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    const outsidePath = await findOutsideWorkspacePath(args, options.workspace);
    return outsidePath === undefined
      ? { decision: "allow" }
      : {
          decision: "deny",
          reason: `Antigravity read access is outside the managed workspace: ${outsidePath}.`,
        };
  }
  if (options.humanInteractionHandler === undefined) {
    return {
      decision: "deny",
      reason: `Pragma requires approval for Antigravity tool ${toolName}, but no approval handler is configured.`,
    };
  }

  const toolCallId = createToolCallId(options.input);
  const reason = "Antigravity requested a potentially side-effecting tool.";
  emitExecutionToolApprovalRequested({
    approval: { mode: "required", reason },
    toolName,
    toolCallId,
    args,
    state: options.toolRuntimeState,
  });
  const response = await options.humanInteractionHandler({
    kind: "tool_approval",
    toolName,
    toolCallId,
    reason,
    input: args,
  });
  if (response.kind !== "tool_approval" || !response.approved) {
    return {
      decision: "deny",
      reason:
        response.kind === "tool_approval" && response.reason !== undefined
          ? response.reason
          : `User declined ${toolName}.`,
    };
  }
  if (response.updatedInput !== undefined && !isDeepStrictEqual(response.updatedInput, args)) {
    const overwrite = createSafeHookOverwrite(args, response.updatedInput);
    if (overwrite === undefined) {
      return {
        decision: "deny",
        reason:
          "Antigravity PreToolUse hooks cannot reproduce the Pragma-edited tool input with a safe shallow overwrite. The original call was denied.",
      };
    }
    return { decision: "allow", overwrite };
  }
  return { decision: "allow" };
}

function createSafeHookOverwrite(
  original: unknown,
  updated: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const originalRecord = asRecord(original);
  const updatedRecord = asRecord(updated);
  if (originalRecord === undefined || updatedRecord === undefined) return undefined;
  return isDeepStrictEqual({ ...originalRecord, ...updatedRecord }, updatedRecord)
    ? updatedRecord
    : undefined;
}

async function handleHookRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly authorization: string;
  readonly workspace: string;
  readonly mcpServerName: string;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly getHumanInteractionHandler: () => ExpertAgentHumanInteractionHandler | undefined;
  readonly toolRuntimeState: ExpertToolRuntimeState;
  readonly isClosing: () => boolean;
}): Promise<void> {
  const { request, response } = options;
  try {
    if (
      request.method !== "POST" ||
      request.url !== "/pre-tool-use" ||
      !matchesSecret(request.headers.authorization, options.authorization)
    ) {
      response.writeHead(404).end();
      return;
    }
    if (options.isClosing()) {
      response.writeHead(503).end();
      return;
    }
    const input = AgyPreToolUseSchema.parse(JSON.parse(await readRequestBody(request)));
    const decision = await decideAntigravityToolUse({
      input,
      workspace: options.workspace,
      mcpServerName: options.mcpServerName,
      permissionMode: options.permissionMode,
      humanInteractionHandler: options.getHumanInteractionHandler(),
      toolRuntimeState: options.toolRuntimeState,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(decision));
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        decision: "deny",
        reason: "Pragma rejected an invalid Antigravity approval-hook request.",
      }),
    );
  }
}

async function answerAgyQuestion(
  options: {
    readonly input: AgyPreToolUseInput;
    readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  },
  args: unknown,
): Promise<AntigravityHookDecision> {
  if (options.humanInteractionHandler === undefined) {
    return {
      decision: "deny",
      reason:
        "Antigravity asked the user a question, but no Pragma interaction handler is configured.",
    };
  }
  const questions = readAgyQuestions(args);
  const response = await options.humanInteractionHandler({
    kind: "user_question",
    toolName: "askUserQuestion",
    toolCallId: createToolCallId(options.input),
    questions,
  });
  if (response.kind !== "user_question" || !response.answered) {
    return {
      decision: "deny",
      reason:
        response.kind === "user_question" && response.reason !== undefined
          ? response.reason
          : "The user did not answer the Antigravity question.",
    };
  }
  const answer = safeJson(response.answers).slice(0, MAX_ANSWER_REASON_CHARACTERS);
  return {
    decision: "deny",
    reason: `Pragma collected the user response: ${answer}. Treat this tool result as the answer and continue without asking again.`,
  };
}

function readAgyQuestions(value: unknown): readonly ExpertAgentUserQuestion[] {
  const record = asRecord(value);
  const rawQuestions = Array.isArray(record?.["Questions"])
    ? record["Questions"]
    : Array.isArray(record?.["questions"])
      ? record["questions"]
      : [value];
  const questions = rawQuestions.flatMap((candidate): ExpertAgentUserQuestion[] => {
    const question = asRecord(candidate);
    const text = readString(question?.["Question"] ?? question?.["question"]);
    if (text === undefined) return [];
    const options = readQuestionOptions(question?.["Options"] ?? question?.["options"]);
    const multi =
      question?.["MultiSelect"] === true ||
      question?.["multiSelect"] === true ||
      question?.["is_multi_select"] === true;
    return [
      {
        question: text,
        header: readString(question?.["Header"] ?? question?.["header"]) ?? "Antigravity",
        kind: options.length === 0 ? "text" : multi ? "multiple_choice" : "single_choice",
        options,
      },
    ];
  });
  return questions.length === 0
    ? [
        {
          question: "Antigravity requested additional user input.",
          header: "Antigravity",
          kind: "text",
          options: [],
        },
      ]
    : questions;
}

function readQuestionOptions(value: unknown): ExpertAgentUserQuestion["options"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const option = asRecord(candidate);
    const label =
      typeof candidate === "string"
        ? candidate
        : readString(option?.["Label"] ?? option?.["label"]);
    if (label === undefined) return [];
    return [
      {
        label,
        description: readString(option?.["Description"] ?? option?.["description"]) ?? "",
      },
    ];
  });
}

async function validateWorkspacePaths(
  paths: readonly string[],
  expectedWorkspace: string,
): Promise<string | undefined> {
  const expected = await canonicalizePathForContainment(expectedWorkspace);
  const normalized = await Promise.all(
    paths.map(async (path) => ({
      reported: resolve(path),
      identity: pathIdentity(await canonicalizePathForContainment(path)),
    })),
  );
  const expectedIdentity = pathIdentity(expected);
  if (!normalized.some((path) => path.identity === expectedIdentity)) {
    return "Antigravity hook workspace identity did not match the managed Runtime workspace.";
  }
  const unexpected = normalized.find((path) => path.identity !== expectedIdentity)?.reported;
  return unexpected === undefined
    ? undefined
    : `Antigravity hook reported an unexpected additional workspace: ${unexpected}.`;
}

async function findOutsideWorkspacePath(
  value: unknown,
  workspace: string,
): Promise<string | undefined> {
  const candidates = collectPathCandidates(value);
  const expected = await canonicalizePathForContainment(workspace);
  for (const rawCandidate of candidates) {
    const candidate = fileUriToPath(rawCandidate);
    if (candidate === undefined) return rawCandidate;
    if (isNonFileUri(rawCandidate)) continue;
    const reportedTarget = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(workspace, candidate);
    const target = await canonicalizePathForContainment(reportedTarget);
    const difference = relative(expected, target);
    if (
      difference === ".." ||
      difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(difference)
    ) {
      return reportedTarget;
    }
  }
  return undefined;
}

function collectPathCandidates(value: unknown, parentKey = "", depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === "string") {
    return /(?:path|file|folder|directory|cwd|target|source|destination|root|uri)/i.test(parentKey)
      ? [value]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectPathCandidates(entry, parentKey, depth + 1));
  }
  const record = asRecord(value);
  if (record === undefined) return [];
  return Object.entries(record).flatMap(([key, entry]) =>
    collectPathCandidates(entry, key, depth + 1),
  );
}

function fileUriToPath(value: string): string | undefined {
  if (!isFileUri(value)) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

function isNonFileUri(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) && !isFileUri(value) && !isAbsolute(value);
}

function isFileUri(value: string): boolean {
  try {
    return new URL(value).protocol.toLowerCase() === "file:";
  } catch {
    return false;
  }
}

async function canonicalizePathForContainment(path: string): Promise<string> {
  let candidate = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(candidate);
      return resolve(canonical, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) return resolve(path);
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function pathIdentity(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isPragmaMcpTool(toolName: string, args: unknown, mcpServerName: string): boolean {
  if (
    toolName.startsWith(`mcp__${mcpServerName}__`) ||
    toolName.startsWith(`mcp_${mcpServerName}_`)
  ) {
    return true;
  }
  const record = asRecord(args);
  if (/^call_mcp_tool$/i.test(toolName)) {
    return (
      readString(
        record?.["ServerName"] ??
          record?.["serverName"] ??
          record?.["server_name"] ??
          record?.["server"],
      ) === mcpServerName
    );
  }
  return (
    /^mcp$/i.test(toolName) &&
    readString(record?.["server"] ?? record?.["serverName"] ?? record?.["server_name"]) ===
      mcpServerName
  );
}

function isUnmanagedMcpTool(toolName: string, args: unknown, mcpServerName: string): boolean {
  if (isPragmaMcpTool(toolName, args, mcpServerName)) return false;
  if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) return true;
  if (!/^(?:call_mcp_tool|mcp)$/i.test(toolName)) return false;
  const record = asRecord(args);
  return (
    readString(
      record?.["ServerName"] ??
        record?.["serverName"] ??
        record?.["server_name"] ??
        record?.["server"],
    ) !== undefined
  );
}

function isTerminalTool(toolName: string): boolean {
  return TERMINAL_TOOL_NAME.test(toolName);
}

function isAskQuestionTool(toolName: string): boolean {
  return /^(?:ask_question|askUserQuestion|ask_user_question)$/i.test(toolName);
}

function createToolCallId(input: AgyPreToolUseInput): string {
  return [
    "agy",
    input.conversationId ?? "conversation",
    input.stepIdx?.toString() ?? randomUUID(),
  ].join(":");
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HOOK_BODY_BYTES) throw new Error("Antigravity hook body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function matchesSecret(value: string | undefined, expected: string): boolean {
  if (value === undefined) return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable response]";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
}
