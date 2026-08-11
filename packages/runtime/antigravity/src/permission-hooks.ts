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
  "edit_file",
  "replace_file_content",
  "write_to_file",
  "write_file",
]);
interface FileToolPathSchema {
  readonly requiredPathGroups: readonly (readonly string[])[];
  readonly optionalPathFields?: readonly string[] | undefined;
}

// agy 1.1.11 exposes file paths in stable, top-level tool arguments. Keep this
// table explicit: recursively guessing from arbitrary key names can both miss a
// new destination field and mistake source/content text for a path.
const FILE_TOOL_PATH_SCHEMAS: Readonly<Record<string, FileToolPathSchema>> = {
  view_file: { requiredPathGroups: [["AbsolutePath"]] },
  list_dir: { requiredPathGroups: [["DirectoryPath"]] },
  grep_search: { requiredPathGroups: [], optionalPathFields: ["SearchPath"] },
  find_by_name: {
    requiredPathGroups: [],
    optionalPathFields: ["SearchPath", "SearchDirectory"],
  },
  list_permissions: {
    requiredPathGroups: [],
    optionalPathFields: ["AbsolutePath", "Target"],
  },
  code_search: { requiredPathGroups: [], optionalPathFields: ["SearchPath"] },
  read_file: { requiredPathGroups: [["AbsolutePath", "TargetFile", "Target"]] },
  get_file_info: { requiredPathGroups: [["AbsolutePath"]] },
  list_directory: { requiredPathGroups: [["DirectoryPath"]] },
  create_directory: { requiredPathGroups: [["DirectoryPath", "TargetDirectory"]] },
  create_file: { requiredPathGroups: [["TargetFile"]] },
  delete_file: { requiredPathGroups: [["TargetFile", "AbsolutePath"]] },
  move_file: {
    requiredPathGroups: [
      ["SourceFile", "SourcePath", "Source", "srcAbsolutePathUri"],
      ["DestinationFile", "DestinationPath", "Destination", "dstAbsolutePathUri"],
    ],
  },
  rename_file: {
    requiredPathGroups: [
      ["SourceFile", "SourcePath", "Source", "srcAbsolutePathUri"],
      ["DestinationFile", "DestinationPath", "Destination", "dstAbsolutePathUri"],
    ],
  },
  edit_file: { requiredPathGroups: [["TargetFile"]] },
  multi_replace_file_content: { requiredPathGroups: [["TargetFile"]] },
  replace_file_content: { requiredPathGroups: [["TargetFile"]] },
  write_to_file: { requiredPathGroups: [["TargetFile"]] },
  write_file: { requiredPathGroups: [["TargetFile"]] },
};
const PATH_FIELD_NAME =
  /(?:path|file|folder|directory|cwd|target|source|destination|root|uri|location)$/i;
const SAFE_MCP_TOOL_NAME = /^[a-z0-9][a-z0-9_.-]*$/i;
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
  readonly allowedWorkspacePaths?: readonly string[] | undefined;
  readonly managedSkillReadRoots?: readonly string[] | undefined;
  readonly mcpServerName: string;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly getHumanInteractionHandler: () => ExpertAgentHumanInteractionHandler | undefined;
  readonly toolRuntimeState: ExpertToolRuntimeState;
  readonly onDecision?:
    | ((event: {
        readonly toolName: string;
        readonly decision: AntigravityHookDecision["decision"];
        readonly permissionOverrides?: readonly string[] | undefined;
      }) => void)
    | undefined;
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
      allowedWorkspacePaths: options.allowedWorkspacePaths,
      managedSkillReadRoots: options.managedSkillReadRoots,
      mcpServerName: options.mcpServerName,
      permissionMode: options.permissionMode,
      getHumanInteractionHandler: options.getHumanInteractionHandler,
      toolRuntimeState: options.toolRuntimeState,
      onDecision: options.onDecision,
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
  readonly allowedWorkspacePaths?: readonly string[] | undefined;
  readonly managedSkillReadRoots?: readonly string[] | undefined;
  readonly mcpServerName: string;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly toolRuntimeState: ExpertToolRuntimeState;
}): Promise<AntigravityHookDecision> {
  const toolName = options.input.toolCall.name;
  const args = options.input.toolCall.args ?? {};
  const workspaceError = await validateWorkspacePaths(
    options.input.workspacePaths,
    options.allowedWorkspacePaths ?? [options.workspace],
  );
  if (workspaceError !== undefined) {
    return { decision: "deny", reason: workspaceError };
  }
  if (isPragmaMcpTool(toolName, args, options.mcpServerName)) {
    const managedToolName = readMcpToolName(args);
    return {
      decision: "allow",
      permissionOverrides: [`mcp(${options.mcpServerName}/${managedToolName})`],
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
    const pathError = await validateKnownFileToolPaths(
      toolName,
      args,
      options.workspace,
      READ_ONLY_TOOLS.has(toolName) ? options.managedSkillReadRoots : undefined,
    );
    return pathError === undefined
      ? { decision: "allow" }
      : {
          decision: "deny",
          reason: `Antigravity auto-approve mode blocked unsafe workspace file arguments: ${pathError}.`,
        };
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
    const pathError = await validateKnownFileToolPaths(
      toolName,
      args,
      options.workspace,
      options.managedSkillReadRoots,
    );
    return pathError === undefined
      ? { decision: "allow" }
      : {
          decision: "deny",
          reason: `Antigravity read access has unsafe workspace file arguments: ${pathError}.`,
        };
  }
  if (AUTO_APPROVABLE_WORKSPACE_TOOLS.has(toolName)) {
    const pathError = await validateKnownFileToolPaths(toolName, args, options.workspace);
    if (pathError !== undefined) {
      return {
        decision: "deny",
        reason: `Antigravity file access has unsafe workspace file arguments: ${pathError}.`,
      };
    }
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
    if (AUTO_APPROVABLE_WORKSPACE_TOOLS.has(toolName)) {
      const pathError = await validateKnownFileToolPaths(
        toolName,
        response.updatedInput,
        options.workspace,
      );
      if (pathError !== undefined) {
        return {
          decision: "deny",
          reason: `Antigravity edited file access has unsafe workspace file arguments: ${pathError}.`,
        };
      }
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
  readonly allowedWorkspacePaths?: readonly string[] | undefined;
  readonly managedSkillReadRoots?: readonly string[] | undefined;
  readonly mcpServerName: string;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly getHumanInteractionHandler: () => ExpertAgentHumanInteractionHandler | undefined;
  readonly toolRuntimeState: ExpertToolRuntimeState;
  readonly onDecision?:
    | ((event: {
        readonly toolName: string;
        readonly decision: AntigravityHookDecision["decision"];
        readonly permissionOverrides?: readonly string[] | undefined;
      }) => void)
    | undefined;
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
      allowedWorkspacePaths: options.allowedWorkspacePaths,
      managedSkillReadRoots: options.managedSkillReadRoots,
      mcpServerName: options.mcpServerName,
      permissionMode: options.permissionMode,
      humanInteractionHandler: options.getHumanInteractionHandler(),
      toolRuntimeState: options.toolRuntimeState,
    });
    options.onDecision?.({
      toolName: input.toolCall.name,
      decision: decision.decision,
      permissionOverrides: decision.permissionOverrides,
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
  allowedWorkspacePaths: readonly string[],
): Promise<string | undefined> {
  const allowedIdentities = new Set(
    await Promise.all(
      allowedWorkspacePaths.map(async (path) =>
        pathIdentity(await canonicalizePathForContainment(path)),
      ),
    ),
  );
  const normalized: { readonly reported: string; readonly identity: string }[] = [];
  for (const rawPath of paths) {
    const path = fileUriToPath(rawPath);
    if (path === undefined || isNonFileUri(rawPath) || !isAbsolute(path)) {
      return `Antigravity hook reported an invalid workspace path: ${rawPath}.`;
    }
    normalized.push({
      reported: resolve(path),
      identity: pathIdentity(await canonicalizePathForContainment(path)),
    });
  }
  const unexpected = normalized.find((path) => !allowedIdentities.has(path.identity))?.reported;
  return unexpected === undefined
    ? undefined
    : `Antigravity hook reported an unexpected additional workspace: ${unexpected}.`;
}

async function validateKnownFileToolPaths(
  toolName: string,
  value: unknown,
  workspace: string,
  additionalReadRoots: readonly string[] = [],
): Promise<string | undefined> {
  const schema = FILE_TOOL_PATH_SCHEMAS[toolName];
  if (schema === undefined) return `${toolName} has no agy 1.1.11 file argument schema`;
  const record = asRecord(value);
  if (record === undefined) return `${toolName} did not provide an object argument`;
  const recognizedFields = new Set([
    ...schema.requiredPathGroups.flat(),
    ...(schema.optionalPathFields ?? []),
  ]);
  const unrecognizedPathField = findUnrecognizedPathField(record, recognizedFields);
  if (unrecognizedPathField !== undefined) {
    return `${toolName} reported an unrecognized path field: ${unrecognizedPathField}`;
  }
  for (const group of schema.requiredPathGroups) {
    if (!group.some((field) => Object.hasOwn(record, field))) {
      return `${toolName} did not provide required path field ${group.join("/")}`;
    }
  }
  const candidates: string[] = [];
  for (const field of recognizedFields) {
    if (!Object.hasOwn(record, field)) continue;
    const candidate = record[field];
    if (typeof candidate !== "string" || candidate.trim() === "") {
      return `${toolName} reported an invalid ${field} path`;
    }
    candidates.push(candidate);
  }
  const expectedRoots = await Promise.all(
    [workspace, ...additionalReadRoots].map(canonicalizePathForContainment),
  );
  for (const rawCandidate of candidates) {
    const candidate = fileUriToPath(rawCandidate);
    if (candidate === undefined || isNonFileUri(rawCandidate)) return rawCandidate;
    const reportedTarget = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(workspace, candidate);
    const target = await canonicalizePathForContainment(reportedTarget);
    if (!expectedRoots.some((root) => isPathContained(root, target))) {
      return reportedTarget;
    }
  }
  return undefined;
}

function findUnrecognizedPathField(
  value: unknown,
  recognizedTopLevelFields: ReadonlySet<string>,
  depth = 0,
): string | undefined {
  if (depth > 6) return "nested argument beyond the supported schema depth";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findUnrecognizedPathField(entry, recognizedTopLevelFields, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const [key, entry] of Object.entries(record)) {
    const recognized = depth === 0 && recognizedTopLevelFields.has(key);
    if (PATH_FIELD_NAME.test(key) && !recognized) return key;
    const nested = findUnrecognizedPathField(entry, recognizedTopLevelFields, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function isPathContained(root: string, target: string): boolean {
  const difference = relative(root, target);
  return !(
    difference === ".." ||
    difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(difference)
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
  const record = asRecord(args);
  if (!/^(?:call_mcp_tool|McpTool|mcp)$/i.test(toolName)) return false;
  const serverName = readString(
    record?.["ServerName"] ??
      record?.["serverName"] ??
      record?.["server_name"] ??
      record?.["server"],
  );
  return serverName === mcpServerName && readMcpToolName(args) !== undefined;
}

function readMcpToolName(args: unknown): string | undefined {
  const record = asRecord(args);
  const explicit = readString(
    record?.["ToolName"] ?? record?.["toolName"] ?? record?.["tool_name"] ?? record?.["tool"],
  );
  return explicit !== undefined && SAFE_MCP_TOOL_NAME.test(explicit) ? explicit : undefined;
}

function isUnmanagedMcpTool(toolName: string, args: unknown, mcpServerName: string): boolean {
  if (isPragmaMcpTool(toolName, args, mcpServerName)) return false;
  if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) return true;
  if (!/^(?:call_mcp_tool|McpTool|mcp)$/i.test(toolName)) return false;
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
