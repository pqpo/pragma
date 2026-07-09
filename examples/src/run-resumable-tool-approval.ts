import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, join, resolve } from "node:path";

import {
  ExpertAgent,
  AgentMessageSchema,
  createDurableHumanInteractionHandler,
  createFileHumanInteractionStore,
  defineRuntimeDriver,
  resolveExpertAgentToolApprovalRequirement,
} from "@pragma/core";
import type {
  ExpertAgentHumanInteractionHandler,
  ExpertAgentHumanRequest,
  ExpertAgentHumanResponse,
  ExpertAgentManagedTool,
  ExpertAgentToolCallResult,
  HumanInteractionStore,
  PendingHumanInteraction,
  RuntimeAdapter,
  RuntimeSessionRef,
  RuntimeStreamEventInput,
} from "@pragma/core";
import type { AgentMessage, AgentMessageUsage } from "@pragma/core";
import { cac } from "cac";
import { z } from "zod";

import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { printRunStream } from "./harness/stream-output.ts";

const agentId = "resumable-approval-example-expert";
const runtimeKind = "example-resumable-runtime";
const runtimeDisplayName = "Example Resumable Runtime";
const defaultQuery = "请执行一次需要人工审批的 deploy_preview 工具，然后告诉我结果。";
const exampleRoot = resolve(defaultWorkspaceRoot, "resumable-approval-example");
const sessionsDir = join(exampleRoot, "sessions");
const humanInteractionsDir = join(exampleRoot, "human-interactions");

const EmptyUsage: AgentMessageUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const ActiveTurnSchema = z.object({
  runId: z.string().min(1),
  query: z.string().min(1),
});

const SessionStateSchema = z.object({
  schemaVersion: z.literal("pragma.example.resumable-approval/v1"),
  workflowId: z.string().min(1),
  runtimeSessionId: z.string().min(1),
  status: z.enum(["ready", "waiting_approval", "completed", "denied"]),
  messages: z.array(AgentMessageSchema),
  activeTurn: ActiveTurnSchema.optional(),
  updatedAt: z.string(),
});

type SessionState = z.infer<typeof SessionStateSchema>;
type ToolApprovalRequest = Extract<ExpertAgentHumanRequest, { readonly kind: "tool_approval" }>;
type PendingToolApprovalRequest = ToolApprovalRequest & { readonly toolCallId: string };

let currentNativeSession: ExampleRuntimeSession | undefined;

interface CliOptions {
  readonly query: string;
  readonly workflowId: string | undefined;
  readonly runtimeSessionId: string | undefined;
  readonly reset: boolean;
}

interface ExampleRuntimeSession {
  readonly workflowId: string;
  readonly runtimeSessionId: string;
  readonly statePath: string;
  state: SessionState;
  readonly humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined;
  readonly deployTool: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;
  readonly interactionStore: HumanInteractionStore;
}

loadExamplesEnv();

const cli = readCliOptions();
await ensureWorkspaceDir(exampleRoot);
await mkdir(sessionsDir, { recursive: true });
const interactionStore = createFileHumanInteractionStore({ rootDir: humanInteractionsDir });

if (cli.reset) {
  await resetRequestedState(cli, interactionStore);
}

const restoreRef = await resolveRuntimeSessionRef(cli, interactionStore);
const workflowId =
  cli.workflowId ??
  (await readWorkflowIdForSession(restoreRef?.id)) ??
  readWorkflowIdFromPending(await readPendingForSession(interactionStore, restoreRef?.id)) ??
  newId("workflow");
const runtimeSessionId = restoreRef?.id ?? newId("session");
const agent = await createExampleAgent(exampleRoot);
const runtime = createResumableApprovalRuntime({ workflowId, interactionStore });
const durableScope = {
  workflowId,
  runtimeSessionId,
};
const session = await runtime.createSession({
  agent,
  runtimeSession: {
    type: runtimeKind,
    id: runtimeSessionId,
  },
  humanInteractionHandler: createDurableHumanInteractionHandler({
    scope: durableScope,
    store: interactionStore,
    delegate: createCliHumanInteractionHandler({
      workflowId,
      runtimeSessionId,
    }),
  }),
});
const currentInfo = session.info();
const resolvedSessionId = currentInfo.runtimeSession.id;

console.log("Resumable approval example");
console.log(`- workflowId: ${workflowId}`);
console.log(`- sessionId: ${resolvedSessionId}`);
console.log(`- state: ${sessionStatePath(resolvedSessionId)}`);
console.log("");

const existingMessages = session.messages();
if (existingMessages.length > 0) {
  printTranscript(existingMessages);
  console.log("");
}

const activeTurn = currentNativeSession?.state.activeTurn;
const runId = activeTurn?.runId ?? newId("run");
const query = activeTurn?.query ?? cli.query;

if ((await interactionStore.getPending(durableScope)) !== undefined) {
  console.log("Restored pending approval; the original request will be shown again.");
  console.log("");
}

const run = session.submit({ runId, query });

try {
  await printRunStream(run);
  const result = await run.result;
  console.log("");
  console.log(`Run ID: ${result.runId}`);
} catch (error) {
  if (isAbortError(error)) {
    console.log("");
    console.log("Interrupted. Pending approval state is persisted and can be resumed.");
    process.exitCode = 130;
  } else {
    throw error;
  }
} finally {
  await session.abort();
}

function readCliOptions(): CliOptions {
  const parser = cac("pragma-example-resumable-approval");

  parser
    .command("[query...]", "Task query to send to the example Agent.")
    .option("--workflow-id <id>", "Resume or create a workflow with this id.")
    .option("--session-id <id>", "Resume the runtime session with this id.")
    .option("--runtime-session-id <id>", "Alias of --session-id.")
    .option("--reset", "Delete persisted state for the selected workflow/session before running.");
  parser.help();

  const parsed = parser.parse();
  if (parsed.options.help === true || parsed.options.version === true) {
    process.exit(0);
  }

  const query = parsed.args
    .filter((arg): arg is string => typeof arg === "string")
    .join(" ")
    .trim();
  const runtimeSessionId =
    readStringOption(parsed.options.sessionId) ?? readStringOption(parsed.options.runtimeSessionId);

  return {
    query: query.length > 0 ? query : defaultQuery,
    workflowId: readStringOption(parsed.options.workflowId),
    runtimeSessionId,
    reset: parsed.options.reset === true,
  };
}

async function createExampleAgent(workspace: string): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    id: agentId,
    name: "Resumable Approval Example Expert",
    description: "Demonstrates durable tool approval recovery after process exit.",
    tags: ["example", "approval", "resume"],
    version: "0.0.0",
    scope: "local-test",
    workspace,
    tools: [
      {
        name: "deploy_preview",
        description: "Deploy a preview environment after explicit human approval.",
        inputSchema: {
          type: "object",
          properties: {
            environment: { type: "string" },
            changeSet: { type: "string" },
          },
          required: ["environment", "changeSet"],
          additionalProperties: false,
        },
        approval: {
          mode: "required",
          reason: "Deploying a preview environment requires operator approval.",
        },
        call: async (args) => {
          const input = z
            .object({
              environment: z.string(),
              changeSet: z.string(),
            })
            .parse(args);

          return {
            text: `Preview deployed to ${input.environment} with ${input.changeSet}.`,
            details: input,
          };
        },
      },
    ],
  });
}

function createResumableApprovalRuntime(options: {
  readonly workflowId: string;
  readonly interactionStore: HumanInteractionStore;
}): RuntimeAdapter {
  return defineRuntimeDriver<never, ExampleRuntimeSession>({
    descriptor: {
      id: runtimeKind,
      kind: runtimeKind,
      displayName: runtimeDisplayName,
      capabilities: {
        targets: ["agent"],
        executionLocations: ["local"],
        supportsAbort: true,
        supportsStreaming: true,
      },
    },
    resolvePersistence() {
      return {
        mode: "checkpoint",
        sessionDir: sessionsDir,
        checkpointOn: ["session.created", "turn.completed", "turn.failed", "session.destroyed"],
        metadata: {
          format: "resumable-approval-example-json",
        },
      };
    },
    createSession(ctx) {
      const runtimeSessionId =
        ctx.persistence.restoredRuntimeSessionId ??
        (ctx.request.runtimeSession?.type === runtimeKind
          ? ctx.request.runtimeSession.id
          : undefined) ??
        newId("session");
      const statePath = sessionStatePath(runtimeSessionId);
      const deployTool = findDeployTool(ctx.agent.tools ?? []);
      const sessionState = existsSync(statePath)
        ? readExistingSessionStateSync(statePath)
        : createInitialSessionState(options.workflowId, runtimeSessionId);

      currentNativeSession = {
        workflowId: sessionState.workflowId,
        runtimeSessionId,
        statePath,
        state: sessionState,
        humanInteractionHandler: ctx.request.humanInteractionHandler,
        deployTool,
        interactionStore: options.interactionStore,
      };

      return currentNativeSession;
    },
    listMessages(session) {
      return session.state.messages;
    },
    readSession(session) {
      return {
        runtimeSessionId: session.runtimeSessionId,
        messages: session.state.messages,
      };
    },
    async startTurn(session, turn) {
      const restoredPending = await session.interactionStore.getPending(interactionScope(session));
      const pending = readToolApprovalRequest(restoredPending) ?? createPendingApproval(session);

      if (session.state.activeTurn === undefined) {
        appendUserMessage(session.state, turn.rawQuery);
        appendAssistantMessage(
          session.state,
          `I need to call ${pending.toolName} and will wait for human approval before continuing.`,
          "toolUse",
        );
        session.state.status = "waiting_approval";
        session.state.activeTurn = {
          runId: turn.runId,
          query: turn.rawQuery,
        };
        await persistSession(session);
      }

      turn.stream.write(createApprovalRequestedEvent(turn.runId, turn.source, pending));

      const approvalRequest: ExpertAgentHumanRequest = {
        kind: "tool_approval",
        toolName: pending.toolName,
        toolCallId: pending.toolCallId,
        ...(pending.reason === undefined ? {} : { reason: pending.reason }),
        input: pending.input,
      };
      const requirement = await resolveExpertAgentToolApprovalRequirement(
        session.deployTool.approval,
        approvalRequest,
      );
      const response =
        requirement === "none"
          ? ({ kind: "tool_approval", approved: true } satisfies ExpertAgentHumanResponse)
          : await requestApproval(session, approvalRequest);

      if (response.kind !== "tool_approval" || !response.approved) {
        const reason =
          response.kind === "tool_approval" && response.reason !== undefined
            ? response.reason
            : "User denied approval.";
        appendAssistantMessage(session.state, `Approval denied: ${reason}`, "stop");
        session.state.status = "denied";
        session.state.activeTurn = undefined;
        await persistSession(session);
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "message.delta",
          payload: {
            role: "assistant",
            contentType: "text",
            delta: `Approval denied: ${reason}`,
          },
        });
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "message.completed",
          payload: {
            role: "assistant",
            contentType: "text",
            text: `Approval denied: ${reason}`,
          },
        });

        return {
          outputText: `Approval denied: ${reason}`,
          runtimeSessionId: session.runtimeSessionId,
        };
      }

      const toolInput = z
        .record(z.string(), z.unknown())
        .parse(response.updatedInput ?? pending.input);
      turn.stream.write({
        runId: turn.runId,
        source: turn.source,
        type: "tool.started",
        payload: {
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          kind: "tool",
          inputPreview: toolInput,
        },
      });

      const toolResult = await session.deployTool.call(toolInput, turn.signal, {
        toolCallId: pending.toolCallId,
      });
      appendToolResultMessage(session.state, pending, toolResult);
      turn.stream.write({
        runId: turn.runId,
        source: turn.source,
        type: "tool.completed",
        payload: {
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          kind: "tool",
          outputPreview: toolResult,
        },
      });

      const finalText = `Approval accepted. ${toolResult.text} Continuing the workflow is complete.`;
      appendAssistantMessage(session.state, finalText, "stop");
      session.state.status = "completed";
      session.state.activeTurn = undefined;
      await persistSession(session);
      turn.stream.write({
        runId: turn.runId,
        source: turn.source,
        type: "message.delta",
        payload: {
          role: "assistant",
          contentType: "text",
          delta: finalText,
        },
      });
      turn.stream.write({
        runId: turn.runId,
        source: turn.source,
        type: "message.completed",
        payload: {
          role: "assistant",
          contentType: "text",
          text: finalText,
        },
      });

      return {
        outputText: finalText,
        runtimeSessionId: session.runtimeSessionId,
      };
    },
    mapEvent() {
      return {};
    },
  });
}

async function requestApproval(
  session: ExampleRuntimeSession,
  request: ExpertAgentHumanRequest,
): Promise<ExpertAgentHumanResponse> {
  if (session.humanInteractionHandler === undefined) {
    return {
      kind: "tool_approval",
      approved: false,
      reason: "No human approval handler is configured.",
    };
  }

  return await session.humanInteractionHandler(request);
}

function createCliHumanInteractionHandler(options: {
  readonly workflowId: string;
  readonly runtimeSessionId: string;
}): ExpertAgentHumanInteractionHandler {
  return async (request) => {
    if (request.kind !== "tool_approval") {
      return {
        kind: "user_question",
        answered: false,
        reason: "This example only handles tool approval requests.",
      };
    }

    console.log("");
    console.log("Approval request");
    console.log(`- workflowId: ${options.workflowId}`);
    console.log(`- sessionId: ${options.runtimeSessionId}`);
    console.log(`- tool: ${request.toolName}`);
    if (request.reason !== undefined) {
      console.log(`- reason: ${request.reason}`);
    }
    console.log(JSON.stringify(request.input, null, 2));
    console.log("");
    console.log("Press Ctrl-C now, then rerun with one of:");
    console.log(
      `pnpm --filter @pragma/examples start:resumable-approval --workflow-id ${options.workflowId}`,
    );
    console.log(
      `pnpm --filter @pragma/examples start:resumable-approval --session-id ${options.runtimeSessionId}`,
    );
    console.log("");

    const rl = createInterface({ input, output });
    let answer: string;
    try {
      answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();
    } finally {
      rl.close();
    }

    if (answer !== "y" && answer !== "yes") {
      return {
        kind: "tool_approval",
        approved: false,
        reason: "User denied approval from CLI.",
      };
    }

    return {
      kind: "tool_approval",
      approved: true,
    };
  };
}

function createPendingApproval(session: ExampleRuntimeSession): PendingToolApprovalRequest {
  return {
    kind: "tool_approval",
    toolCallId: newId("tool-call"),
    toolName: session.deployTool.name,
    ...(session.deployTool.approval?.reason === undefined
      ? {}
      : { reason: session.deployTool.approval.reason }),
    input: {
      environment: "preview",
      changeSet: `workflow ${session.workflowId}`,
    },
  };
}

function readToolApprovalRequest(
  interaction: PendingHumanInteraction | undefined,
): PendingToolApprovalRequest | undefined {
  if (interaction?.request.kind !== "tool_approval") {
    return undefined;
  }

  return {
    ...interaction.request,
    toolCallId: interaction.request.toolCallId ?? newId("tool-call"),
  };
}

function interactionScope(session: ExampleRuntimeSession): {
  readonly workflowId: string;
  readonly runtimeSessionId: string;
} {
  return {
    workflowId: session.workflowId,
    runtimeSessionId: session.runtimeSessionId,
  };
}

function createApprovalRequestedEvent(
  runId: string,
  source: RuntimeStreamEventInput["source"],
  pending: PendingToolApprovalRequest,
): RuntimeStreamEventInput {
  return {
    runId,
    source: {
      ...source,
      kind: "tool",
      toolCallId: pending.toolCallId,
    },
    type: "tool.approval_requested",
    payload: {
      approvalId: `approval-${pending.toolCallId}`,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      kind: "tool",
      ...(pending.reason === undefined ? {} : { reason: pending.reason }),
      inputPreview: pending.input,
    },
  };
}

function appendUserMessage(state: SessionState, query: string): void {
  state.messages.push({
    role: "user",
    content: query,
    timestamp: Date.now(),
  });
}

function appendAssistantMessage(
  state: SessionState,
  text: string,
  stopReason: "stop" | "toolUse",
): void {
  state.messages.push({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "example",
    provider: "pragma-example",
    model: "deterministic-resumable-runtime",
    usage: EmptyUsage,
    stopReason,
    timestamp: Date.now(),
  });
}

function appendToolResultMessage(
  state: SessionState,
  pending: PendingToolApprovalRequest,
  result: ExpertAgentToolCallResult,
): void {
  state.messages.push({
    role: "toolResult",
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    content: [{ type: "text", text: result.text }],
    details: result.details,
    isError: result.isError ?? false,
    timestamp: Date.now(),
  });
}

function printTranscript(messages: readonly AgentMessage[]): void {
  console.log("Restored transcript:");

  for (const message of messages) {
    if (message.role === "user") {
      console.log(
        `USER: ${typeof message.content === "string" ? message.content : "<multimodal>"}`,
      );
      continue;
    }

    if (message.role === "assistant") {
      console.log(`ASSISTANT: ${message.content.map((part) => readContentText(part)).join("")}`);
      continue;
    }

    if (message.role === "toolResult") {
      console.log(
        `TOOL ${message.toolName}: ${message.content.map((part) => readContentText(part)).join("")}`,
      );
      continue;
    }

    if (message.role === "custom" && message.display) {
      console.log(`CUSTOM ${message.customType}: ${String(message.content)}`);
    }
  }
}

function readContentText(content: { readonly type: string }): string {
  if (content.type === "text" && "text" in content && typeof content.text === "string") {
    return content.text;
  }

  if (
    content.type === "thinking" &&
    "thinking" in content &&
    typeof content.thinking === "string"
  ) {
    return content.thinking;
  }

  if (content.type === "toolCall" && "name" in content && typeof content.name === "string") {
    return `[tool call: ${content.name}]`;
  }

  return `[${content.type}]`;
}

async function resolveRuntimeSessionRef(
  cli: CliOptions,
  store: HumanInteractionStore,
): Promise<RuntimeSessionRef | undefined> {
  const sessionId =
    cli.runtimeSessionId ??
    readRuntimeSessionIdFromPending(
      cli.workflowId === undefined ? undefined : await store.getPending({ workflowId: cli.workflowId }),
    );

  return sessionId === undefined
    ? undefined
    : {
        type: runtimeKind,
        id: sessionId,
      };
}

async function readWorkflowIdForSession(
  sessionId: string | undefined,
): Promise<string | undefined> {
  if (sessionId === undefined) {
    return undefined;
  }

  const statePath = sessionStatePath(sessionId);
  if (!existsSync(statePath)) {
    return undefined;
  }

  return SessionStateSchema.parse(JSON.parse(await readFile(statePath, "utf8"))).workflowId;
}

async function readPendingForSession(
  store: HumanInteractionStore,
  sessionId: string | undefined,
): Promise<PendingHumanInteraction | undefined> {
  return sessionId === undefined ? undefined : await store.getPending({ runtimeSessionId: sessionId });
}

function readRuntimeSessionIdFromPending(
  interaction: PendingHumanInteraction | undefined,
): string | undefined {
  return interaction?.scope["runtimeSessionId"];
}

function readWorkflowIdFromPending(
  interaction: PendingHumanInteraction | undefined,
): string | undefined {
  return interaction?.scope["workflowId"];
}

async function resetRequestedState(
  cli: CliOptions,
  store: HumanInteractionStore,
): Promise<void> {
  const sessionIds = new Set<string>();

  if (cli.runtimeSessionId !== undefined) {
    sessionIds.add(cli.runtimeSessionId);
    for (const interaction of await store.listPending({ runtimeSessionId: cli.runtimeSessionId })) {
      await store.clear(interaction.id);
    }
  }

  if (cli.workflowId !== undefined) {
    for (const interaction of await store.listPending({ workflowId: cli.workflowId })) {
      const sessionId = readRuntimeSessionIdFromPending(interaction);
      if (sessionId !== undefined) {
        sessionIds.add(sessionId);
      }
      await store.clear(interaction.id);
    }
  }

  for (const sessionId of sessionIds) {
    await rm(dirname(sessionStatePath(sessionId)), { recursive: true, force: true });
  }
}

function readExistingSessionStateSync(path: string): SessionState {
  return SessionStateSchema.parse(JSON.parse(readFileSyncUtf8(path)));
}

function readFileSyncUtf8(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "{}";
}

function createInitialSessionState(workflowId: string, runtimeSessionId: string): SessionState {
  return {
    schemaVersion: "pragma.example.resumable-approval/v1",
    workflowId,
    runtimeSessionId,
    status: "ready",
    messages: [],
    updatedAt: new Date().toISOString(),
  };
}

async function persistSession(session: ExampleRuntimeSession): Promise<void> {
  await saveSessionState(session.statePath, session.state);
}

async function saveSessionState(path: string, state: SessionState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ...state,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function sessionStatePath(sessionId: string): string {
  return join(sessionsDir, encodeURIComponent(sessionId), "state.json");
}

function findDeployTool(
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
): ExpertAgentManagedTool<string, ExpertAgentToolCallResult> {
  const tool = tools.find((candidate) => candidate.name === "deploy_preview");

  if (tool === undefined) {
    throw new Error("deploy_preview tool is not configured.");
  }

  return tool;
}

function readStringOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "AbortError" ||
    ("code" in error && error.code === "ABORT_ERR") ||
    error.message === "Agent session was aborted."
  );
}
