/*
 * Deferred until PragmaApp.resume(rootDefinition, { workflowRunId }) is implemented.
 * Keep this previous direct-Session example as migration source; do not expose it as a runnable
 * public example during the unified-execution phase.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  ExpertAgent,
  RuntimeSessionRefSchema,
  createDurableHumanInteractionHandler,
  createFileHumanInteractionStore,
} from "@pragma/core";
import type {
  AgentMessage,
  ExpertAgentHumanInteractionHandler,
  HumanInteractionScope,
  HumanInteractionStore,
  PendingHumanInteraction,
  RuntimeSessionRef,
} from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";
import { cac } from "cac";
import { z } from "zod";

import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { createConsoleChat, type ConsoleChat } from "./harness/console-chat.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { exitIfRuntimeUnavailable } from "./harness/runtime-availability.ts";
import { printRunStream } from "./harness/stream-output.ts";

const agentId = "resumable-approval-example-expert";
const runtimeKind = "cloud-pi-agent";
const exampleRoot = resolve(defaultWorkspaceRoot, "resumable-approval-example");
const workspace = join(exampleRoot, "workspace");
const workflowsDir = join(exampleRoot, "workflows");
const humanInteractionsDir = join(exampleRoot, "human-interactions");

const WorkflowStateSchema = z.object({
  schemaVersion: z.literal("pragma.example.resumable-approval/v5"),
  workflowId: z.string().min(1),
  systemSessionId: z.string().min(1),
  runtimeSession: RuntimeSessionRefSchema,
  status: z.enum(["ready", "waiting_approval", "running"]),
  activeQuery: z.string().min(1).optional(),
  lastOutput: z.string().optional(),
  updatedAt: z.string().datetime(),
});

type WorkflowState = z.infer<typeof WorkflowStateSchema>;

interface CliOptions {
  readonly query: string | undefined;
  readonly workflowId: string | undefined;
  readonly runtimeSessionId: string | undefined;
  readonly reset: boolean;
}

loadExamplesEnv();

const cli = readCliOptions();
await ensureWorkspaceDir(workspace);
await mkdir(workflowsDir, { recursive: true });
const interactionStore = createFileHumanInteractionStore({ rootDir: humanInteractionsDir });

if (cli.reset) {
  await resetRequestedState(cli, interactionStore);
}

const existingState = await findWorkflowState(cli);
if (cli.runtimeSessionId !== undefined && existingState === undefined) {
  throw new Error(
    `No persisted Workflow mapping was found for Runtime Session ${cli.runtimeSessionId}. Resume requires its original workflowId and systemSessionId.`,
  );
}
const workflowId = existingState?.workflowId ?? cli.workflowId ?? newId("workflow");
const systemSessionId = existingState?.systemSessionId ?? newId("system-session");
const requestedRuntimeSession =
  existingState?.runtimeSession ??
  (cli.runtimeSessionId === undefined ? undefined : createRuntimeSessionRef(cli.runtimeSessionId));
let runtimeSession: RuntimeSessionRef | undefined = requestedRuntimeSession;
let workflowState: WorkflowState | undefined = existingState;
const interactionScope: HumanInteractionScope = {
  workflowId,
  runtimeSessionType: runtimeKind,
};

const pendingBeforeRun = await interactionStore.getPending(interactionScope);
const modelConfig = readExampleModelConfig();
const agent = await createExampleAgent(modelConfig, workflowId);
const runtime = createPiRuntime();
await exitIfRuntimeUnavailable(runtime);
const chat = createConsoleChat();
const session = await runtime.createSession({
  agent,
  owner: { workflowRunId: workflowId },
  systemSessionId,
  ...(requestedRuntimeSession === undefined ? {} : { runtimeSession: requestedRuntimeSession }),
  humanInteractionHandler: createDurableHumanInteractionHandler({
    scope: interactionScope,
    store: interactionStore,
    delegate: createCliHumanInteractionHandler({
      workflowId,
      getRuntimeSession: () => {
        if (runtimeSession === undefined) {
          throw new Error("Runtime session is not initialized.");
        }
        return runtimeSession;
      },
      chat,
      onStatus: async (status) => {
        if (workflowState === undefined) {
          throw new Error("Workflow state is not initialized.");
        }
        workflowState = { ...workflowState, status };
        await saveWorkflowState(workflowState);
      },
    }),
  }),
});
runtimeSession = session.info().runtimeSession;
workflowState = {
  ...(existingState ?? createWorkflowState(workflowId, systemSessionId, runtimeSession)),
  runtimeSession,
};
await saveWorkflowState(workflowState);

console.log("Resumable approval example (PI runtime)");
console.log(`- workflowId: ${workflowId}`);
console.log(`- systemSessionId: ${systemSessionId}`);
console.log(`- session: ${runtimeSession.type}:${runtimeSession.id}`);
console.log(`- workflow state: ${workflowStatePath(workflowId)}`);
console.log("");

console.log(`- model: ${formatModelConfig(modelConfig)}`);
const existingMessages = session.messages();
if (existingMessages.length > 0) {
  console.log("");
  printTranscript(existingMessages);
}

let initialMessage = cli.query;
if (pendingBeforeRun !== undefined) {
  console.log("");
  console.log("Restored the interrupted approval; PI will regenerate the same logical tool call.");
  initialMessage = createResumeQuery(pendingBeforeRun);
} else if (workflowState.status !== "ready") {
  workflowState = { ...workflowState, status: "ready", activeQuery: undefined };
  await saveWorkflowState(workflowState);
}

try {
  console.log("");
  console.log("Chat ready. Ask the agent to call deploy_preview; use /exit to quit.");

  await chat.run({
    initialMessage,
    onMessage: async (query) => {
      const currentState = requireWorkflowState(workflowState);
      workflowState = {
        ...currentState,
        status: "running",
        activeQuery: query,
      };
      await saveWorkflowState(requireWorkflowState(workflowState));

      const run = session.submit({ query });
      await printRunStream(run);
      const result = await run.result;
      const completedState = requireWorkflowState(workflowState);
      workflowState = {
        ...completedState,
        status: "ready",
        activeQuery: undefined,
        lastOutput: result.result.output,
      };
      await saveWorkflowState(requireWorkflowState(workflowState));
      console.log("");
    },
  });
} catch (error) {
  if (isAbortError(error)) {
    console.log("");
    console.log("Interrupted. Pending approval and workflow-to-session mapping are persisted.");
    process.exitCode = 130;
  } else {
    throw error;
  }
} finally {
  chat.close();
  await session.abort();
}

function readCliOptions(): CliOptions {
  const parser = cac("pragma-example-resumable-approval");

  parser
    .command("[query...]", "Optional first chat message. Without it, wait at the chat prompt.")
    .option("--workflow-id <id>", "Resume or inspect a workflow with this id.")
    .option("--session-id <id>", "Resume the PI runtime session with this id.")
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

  return {
    query: query.length === 0 ? undefined : query,
    workflowId: readStringOption(parsed.options.workflowId),
    runtimeSessionId:
      readStringOption(parsed.options.sessionId) ??
      readStringOption(parsed.options.runtimeSessionId),
    reset: parsed.options.reset === true,
  };
}

async function createExampleAgent(
  modelConfig: ReturnType<typeof readExampleModelConfig>,
  workflowId: string,
): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    id: agentId,
    name: "Resumable Approval Example Expert",
    description: "Demonstrates durable tool approval recovery with the real PI runtime.",
    tags: ["example", "approval", "resume", "pi"],
    version: "0.0.0",
    scope: "local-test",
    workspace,
    models: createExpertAgentModelsConfig(modelConfig),
    instructions: [
      "When asked to deploy a preview, call deploy_preview exactly once.",
      `The current workflow id is ${workflowId}. Use it verbatim as changeSet.`,
      "After the tool returns, report its result and do not call it again.",
    ].join("\n"),
    tools: [
      {
        name: "deploy_preview",
        description: "Deploy a preview environment after explicit human approval.",
        inputSchema: {
          type: "object",
          properties: {
            environment: { type: "string", const: "preview" },
            changeSet: { type: "string", const: workflowId },
          },
          required: ["environment", "changeSet"],
          additionalProperties: false,
        },
        approval: {
          mode: "required",
          reason: "Deploying a preview environment requires operator approval.",
        },
        call: async (args) => {
          const deployInput = z
            .object({
              environment: z.literal("preview"),
              changeSet: z.literal(workflowId),
            })
            .parse(args);

          return {
            text: `Preview deployed to ${deployInput.environment} for ${deployInput.changeSet}.`,
            details: deployInput,
          };
        },
      },
    ],
  });
}

function createCliHumanInteractionHandler(options: {
  readonly workflowId: string;
  readonly getRuntimeSession: () => RuntimeSessionRef;
  readonly chat: ConsoleChat;
  readonly onStatus: (status: "waiting_approval" | "running") => Promise<void>;
}): ExpertAgentHumanInteractionHandler {
  return async (request) => {
    if (request.kind !== "tool_approval") {
      return {
        kind: "user_question",
        answered: false,
        reason: "This example only handles tool approval requests.",
      };
    }

    await options.onStatus("waiting_approval");
    console.log("");
    console.log("Approval request");
    console.log(`- workflowId: ${options.workflowId}`);
    const runtimeSession = options.getRuntimeSession();
    console.log(`- session: ${runtimeSession.type}:${runtimeSession.id}`);
    console.log(`- tool: ${request.toolName}`);
    if (request.reason !== undefined) {
      console.log(`- reason: ${request.reason}`);
    }
    console.log(JSON.stringify(request.input, null, 2));
    console.log("");
    console.log("Press Ctrl-C now, then rerun with:");
    console.log(
      `pnpm --filter @pragma/examples dev src/run-resumable-tool-approval.ts --workflow-id ${options.workflowId}`,
    );
    console.log("");

    const answer = (await options.chat.question("Approve? [y/N] ")).trim().toLowerCase();

    if (answer !== "y" && answer !== "yes") {
      await options.onStatus("running");
      return {
        kind: "tool_approval",
        approved: false,
        reason: "User denied approval from CLI.",
      };
    }

    await options.onStatus("running");
    return { kind: "tool_approval", approved: true };
  };
}

function createResumeQuery(pending: PendingHumanInteraction): string {
  if (pending.request.kind !== "tool_approval") {
    throw new Error(`Cannot resume unsupported interaction kind: ${pending.request.kind}`);
  }
  return [
    "The previous process stopped while the following tool call was waiting for approval.",
    "Regenerate this exact logical tool call now so the durable approval can resume; do not change its input.",
    `tool: ${pending.request.toolName}`,
    `input: ${JSON.stringify(pending.request.input)}`,
    "After the tool returns, report the result and finish.",
  ].join("\n");
}

async function findWorkflowState(cli: CliOptions): Promise<WorkflowState | undefined> {
  if (cli.workflowId !== undefined) {
    return await readWorkflowState(cli.workflowId);
  }

  if (cli.runtimeSessionId === undefined) {
    return undefined;
  }

  const entries = await readdir(workflowsDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const parsedState = WorkflowStateSchema.safeParse(
      JSON.parse(await readFile(join(workflowsDir, entry), "utf8")),
    );
    if (!parsedState.success) {
      continue;
    }
    const state = parsedState.data;
    if (state.runtimeSession.id === cli.runtimeSessionId) {
      return state;
    }
  }

  return undefined;
}

async function readWorkflowState(workflowId: string): Promise<WorkflowState | undefined> {
  const path = workflowStatePath(workflowId);
  if (!existsSync(path)) {
    return undefined;
  }

  return WorkflowStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function createWorkflowState(
  workflowId: string,
  systemSessionId: string,
  runtimeSession: RuntimeSessionRef,
): WorkflowState {
  return {
    schemaVersion: "pragma.example.resumable-approval/v5",
    workflowId,
    systemSessionId,
    runtimeSession,
    status: "ready",
    updatedAt: new Date().toISOString(),
  };
}

async function saveWorkflowState(state: WorkflowState): Promise<void> {
  const next = WorkflowStateSchema.parse({
    ...state,
    updatedAt: new Date().toISOString(),
  });
  await mkdir(dirname(workflowStatePath(state.workflowId)), { recursive: true });
  await writeFile(
    workflowStatePath(state.workflowId),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
}

async function resetRequestedState(cli: CliOptions, store: HumanInteractionStore): Promise<void> {
  if (cli.workflowId !== undefined) {
    for (const interaction of await store.listPending({ workflowId: cli.workflowId })) {
      await store.clear(interaction.id);
    }
    await rm(workflowStatePath(cli.workflowId), { force: true });
    return;
  }

  const state = await findWorkflowState(cli);
  const workflowId = state?.workflowId ?? cli.workflowId;
  if (workflowId !== undefined) {
    for (const interaction of await store.listPending({ workflowId })) {
      await store.clear(interaction.id);
    }
    await rm(workflowStatePath(workflowId), { force: true });
  }
}

function printTranscript(messages: readonly AgentMessage[]): void {
  console.log("Restored PI transcript:");
  for (const message of messages) {
    if (message.role === "user") {
      console.log(
        `USER: ${typeof message.content === "string" ? message.content : "<multimodal>"}`,
      );
    } else if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      console.log(`ASSISTANT: ${text || "<tool call>"}`);
    } else if (message.role === "toolResult") {
      console.log(`TOOL ${message.toolName}: ${message.isError ? "failed" : "completed"}`);
    }
  }
}

function workflowStatePath(workflowId: string): string {
  return join(workflowsDir, `${encodeURIComponent(workflowId)}.json`);
}

function readStringOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function createRuntimeSessionRef(runtimeSessionId: string): RuntimeSessionRef {
  return {
    type: runtimeKind,
    id: runtimeSessionId,
  };
}

function requireWorkflowState(state: WorkflowState | undefined): WorkflowState {
  if (state === undefined) {
    throw new Error("Workflow state is not initialized.");
  }
  return state;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "Aborted");
}
*/
