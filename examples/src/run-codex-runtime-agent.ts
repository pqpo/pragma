import { cac } from "cac";

import {
  ExpertAgent,
  createCodexLocalRuntimeAdapter,
  type CodexRuntimeApprovalPolicy,
  type CodexRuntimeSandboxMode,
  type RuntimeSessionRef,
} from "@pragma/core";

import { printRunHeader, printRunResult } from "./harness/expert-agent-example-utils.ts";
import { createExampleLoggerProvider } from "./harness/logger.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { printRunStream } from "./harness/stream-output.ts";

interface CodexRuntimeExampleCliOptions {
  readonly turns: readonly string[];
  readonly model: string | undefined;
  readonly runtimeSessionId: string | undefined;
  readonly systemSessionId: string | undefined;
  readonly sandboxMode: CodexRuntimeSandboxMode | undefined;
  readonly approvalPolicy: CodexRuntimeApprovalPolicy | undefined;
}

const defaultQuery =
  "用两句话介绍 Pragma，并说明你当前是通过 Codex local runtime 运行的。";

loadExamplesEnv();

const cli = readCodexRuntimeExampleCli();
const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const loggerProvider = createExampleLoggerProvider();
const agent = await ExpertAgent.create({
  id: "codex-runtime-example-expert",
  name: "Codex Runtime Example Expert",
  description: "Demonstrates running an ExpertAgent through the local Codex runtime.",
  instructions: [
    "You are an ExpertAgent running through Pragma's Codex local runtime adapter.",
    "Answer concisely and mention concrete files or commands only when useful.",
  ].join("\n"),
  tags: ["example", "codex-runtime"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  loggerProvider,
});

const runtime = createCodexLocalRuntimeAdapter({
  loggerProvider,
  defaultModelName: cli.model,
  sandboxMode: cli.sandboxMode,
  approvalPolicy: cli.approvalPolicy,
});
const runtimeSession = createRuntimeSessionRef(cli.runtimeSessionId);
const session = await runtime.createSession({
  agent,
  ...(cli.systemSessionId === undefined ? {} : { systemSessionId: cli.systemSessionId }),
  ...(runtimeSession === undefined ? {} : { runtimeSession }),
});

try {
  const sessionInfo = session.info();

  console.log("Codex runtime session:");
  console.log(`- systemSessionId: ${sessionInfo.systemSessionId}`);
  console.log(`- runtimeSessionId: ${sessionInfo.runtimeSession.id}`);
  console.log(`- runtime: ${sessionInfo.runtime.displayName} (${sessionInfo.runtime.id})`);
  console.log(`- model: ${cli.model ?? "Codex config default"}`);
  console.log(`- sandbox: ${cli.sandboxMode ?? "Codex config default"}`);
  console.log(`- approvalPolicy: ${cli.approvalPolicy ?? "Codex config default"}`);
  console.log("");

  for (const [index, query] of cli.turns.entries()) {
    console.log(`Turn ${index + 1}/${cli.turns.length}`);
    printRunHeader(agent, cli.model ?? "Codex config default", query);
    const run = session.submit({
      query,
      ...(cli.model === undefined ? {} : { modelName: cli.model }),
    });

    await printRunStream(run);

    const result = await run.result;
    printRunResult(result.runId);
    console.log("");
  }
} finally {
  await session.abort();
}

function readCodexRuntimeExampleCli(): CodexRuntimeExampleCliOptions {
  const cli = cac("pragma-example-codex-runtime");

  cli
    .command("[query...]", "Task query to send to the Codex-backed ExpertAgent.")
    .option("--turn <query>", "Task query to submit. Repeat this option for multi-turn tests.")
    .option("--model <model>", "Codex model name to pass to thread/start and turn/start.")
    .option("--runtime-session-id <id>", "Resume an existing Codex runtime thread id.")
    .option("--system-session-id <id>", "Use a fixed Pragma system session id.")
    .option(
      "--sandbox <mode>",
      "Codex sandbox mode: read-only, workspace-write, or danger-full-access.",
    )
    .option(
      "--approval-policy <policy>",
      "Codex approval policy: untrusted, on-request, or never.",
    );
  cli.help();

  const parsed = cli.parse();

  if (parsed.options.help === true || parsed.options.version === true) {
    process.exit(0);
  }

  return {
    turns: readTurns(parsed.args, parsed.options.turn),
    model: readStringOption(parsed.options.model),
    runtimeSessionId: readStringOption(parsed.options.runtimeSessionId),
    systemSessionId: readStringOption(parsed.options.systemSessionId),
    sandboxMode: readSandboxModeOption(parsed.options.sandbox),
    approvalPolicy: readApprovalPolicyOption(parsed.options.approvalPolicy),
  };
}

function createRuntimeSessionRef(
  runtimeSessionId: string | undefined,
): RuntimeSessionRef | undefined {
  if (runtimeSessionId === undefined) {
    return undefined;
  }

  return {
    type: "codex-local",
    id: runtimeSessionId,
  };
}

function readTurns(args: readonly unknown[], turnOption: unknown): readonly string[] {
  const turns = readStringListOption(turnOption);

  if (turns.length > 0) {
    return turns;
  }

  const query = args
    .filter((arg): arg is string => typeof arg === "string")
    .join(" ")
    .trim();

  return [query.length > 0 ? query : defaultQuery];
}

function readStringListOption(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  const stringValue = readStringOption(value);

  return stringValue === undefined ? [] : [stringValue];
}

function readSandboxModeOption(value: unknown): CodexRuntimeSandboxMode | undefined {
  const option = readStringOption(value);

  if (option === undefined) {
    return undefined;
  }

  if (option === "read-only" || option === "workspace-write" || option === "danger-full-access") {
    return option;
  }

  throw new Error(`Unsupported Codex sandbox mode: ${option}`);
}

function readApprovalPolicyOption(value: unknown): CodexRuntimeApprovalPolicy | undefined {
  const option = readStringOption(value);

  if (option === undefined) {
    return undefined;
  }

  if (option === "untrusted" || option === "on-request" || option === "never") {
    return option;
  }

  throw new Error(`Unsupported Codex approval policy: ${option}`);
}

function readStringOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}
