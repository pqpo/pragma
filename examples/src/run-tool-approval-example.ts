import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { ExpertAgent } from "@pragma/core";
import type { ExpertAgentHumanInteractionHandler } from "@pragma/core";
import { createCloudPiRuntimeAdapter } from "@pragma/core";

import toolApprovalPolicyPlugin from "../plugins/tool-approval-policy/src/plugin.ts";
import {
  printPluginLoadIssues,
  printRunHeader,
  printRunResult,
} from "./harness/expert-agent-example-utils.ts";
import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { readBasicExampleCli } from "./harness/cli.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { printRunStream } from "./harness/stream-output.ts";

const defaultQuery = "先调用 askUserQuestion 问我是否继续，然后再执行一个需要确认的工具。";

loadExamplesEnv();

const cli = readBasicExampleCli(defaultQuery);
const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const modelConfig = readExampleModelConfig();
const agent = await ExpertAgent.create({
  schemaVersion: "pragma.expert/v1",
  id: "tool-approval-example-expert",
  name: "Tool Approval Example Expert",
  description: "Demonstrates approval-required tools and askUserQuestion.",
  tags: ["example", "approval"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  models: createExpertAgentModelsConfig(modelConfig),
  tools: [
    {
      name: "delete_workspace_note",
      description: "Delete a workspace note after explicit confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      call: async (args) => ({
        text: `Deleted workspace note at ${(args as { path?: string }).path ?? "<unknown>"}`,
      }),
    },
  ],
  plugins: [{ entry: toolApprovalPolicyPlugin }],
});

const runtime = createCloudPiRuntimeAdapter();
const session = await runtime.createSession({
  agent,
  humanInteractionHandler: createCliHumanInteractionHandler(),
});

try {
  printPluginLoadIssues(agent);

  console.log("Approval example:");
  console.log(`- tools: ${agent.tools?.map((tool) => tool.name).join(", ") ?? "<none>"}`);
  console.log("");

  for (const [index, query] of cli.turns.entries()) {
    console.log(`Turn ${index + 1}/${cli.turns.length}`);
    printRunHeader(agent, formatModelConfig(modelConfig), query);
    const run = session.submit({ query });
    await printRunStream(run);
    const result = await run.result;
    printRunResult(result.runId);
    console.log("");
  }
} finally {
  await session.abort();
}

function createCliHumanInteractionHandler(): ExpertAgentHumanInteractionHandler {
  const rl = createInterface({ input, output });

  return async (request) => {
    if (request.kind === "user_question") {
      console.log("");
      console.log(`[question] ${request.toolName}`);

      return {
        kind: "user_question",
        answered: true,
        answers: await readCliQuestionAnswers(rl, request.questions),
      };
    }

    console.log("");
    console.log(`[approval] ${request.toolName}`);
    if (request.reason !== undefined) {
      console.log(request.reason);
    }
    console.log(JSON.stringify(request.input, null, 2));
    const answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();

    if (answer !== "y" && answer !== "yes") {
      return { kind: "tool_approval", approved: false, reason: "User denied approval." };
    }

    return { kind: "tool_approval", approved: true };
  };
}

interface CliQuestion {
  readonly header: string;
  readonly question: string;
  readonly kind?: "single_choice" | "multiple_choice" | "text" | undefined;
  readonly options?:
    | readonly { readonly label: string; readonly description?: string }[]
    | undefined;
}

async function readCliQuestionAnswers(
  rl: ReturnType<typeof createInterface>,
  questions: readonly CliQuestion[],
): Promise<unknown> {
  if (questions.length === 0) {
    const response = (await rl.question("Answer (plain text or JSON): ")).trim();
    return parseCliQuestionAnswer(response);
  }

  const answers: unknown[] = [];

  for (const question of questions) {
    console.log("");
    console.log(`${question.header}: ${question.question}`);

    if (question.kind === "single_choice") {
      answers.push({
        header: question.header,
        question: question.question,
        kind: question.kind,
        selected: await readSingleChoiceAnswer(rl, question.options ?? []),
      });
      continue;
    }

    if (question.kind === "multiple_choice") {
      answers.push({
        header: question.header,
        question: question.question,
        kind: question.kind,
        selected: await readMultipleChoiceAnswer(rl, question.options ?? []),
      });
      continue;
    }

    answers.push({
      header: question.header,
      question: question.question,
      kind: "text",
      answer: await rl.question("Answer: "),
    });
  }

  return { answers };
}

async function readSingleChoiceAnswer(
  rl: ReturnType<typeof createInterface>,
  options: readonly { readonly label: string; readonly description?: string }[],
): Promise<string> {
  printChoiceOptions(options);
  const response = (await rl.question("Choose one: ")).trim();
  return resolveChoiceLabel(response, options) ?? response;
}

async function readMultipleChoiceAnswer(
  rl: ReturnType<typeof createInterface>,
  options: readonly { readonly label: string; readonly description?: string }[],
): Promise<readonly string[]> {
  printChoiceOptions(options);
  const response = (await rl.question("Choose one or more, comma separated: ")).trim();

  return response
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => resolveChoiceLabel(part, options) ?? part);
}

function printChoiceOptions(
  options: readonly { readonly label: string; readonly description?: string }[],
): void {
  for (const [index, option] of options.entries()) {
    const description =
      option.description === undefined || option.description.length === 0
        ? ""
        : ` - ${option.description}`;
    console.log(`${index + 1}. ${option.label}${description}`);
  }
}

function resolveChoiceLabel(
  response: string,
  options: readonly { readonly label: string; readonly description?: string }[],
): string | undefined {
  const index = Number.parseInt(response, 10);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1]?.label;
  }

  return options.find((option) => option.label === response)?.label;
}

function parseCliQuestionAnswer(response: string): unknown {
  if (response.length === 0) {
    return { answered: true };
  }

  try {
    return JSON.parse(response);
  } catch {
    return { answer: response };
  }
}
