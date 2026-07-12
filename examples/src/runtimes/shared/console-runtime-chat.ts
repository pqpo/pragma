import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";

import {
  ContextSystem,
  createInMemoryContextStore,
  createConsoleLoggerProvider,
  createPragma,
  createRuntimeRegistry,
  defineExpert,
  type ExpertSession,
  type RuntimeAdapter,
  type RuntimeModel,
  type RuntimeThinkingLevel,
} from "@pragma/core";

import { renderExpertTurn } from "../../console/console-turn-renderer.ts";
import { formatConsoleUsage } from "../../console/console-usage.ts";

export interface RuntimeConsoleChatOptions {
  readonly runtimeName: string;
  readonly expertId: string;
  readonly createRuntime: (defaults?: RuntimeConsoleDefaults) => RuntimeAdapter;
}

export interface RuntimeConsoleDefaults {
  readonly modelName?: string | undefined;
  readonly thinkingLevel?: string | undefined;
}

export async function runRuntimeConsoleChat(options: RuntimeConsoleChatOptions): Promise<void> {
  const terminal = createInterface({ input: stdin, output: stdout });
  let session: ExpertSession | undefined;

  try {
    const probeRuntime = options.createRuntime();
    console.log(`正在检查 ${options.runtimeName}...`);
    const availability = await probeRuntime.canUse();
    if (!availability.usable) {
      throw new Error(availability.reason ?? `${options.runtimeName} 当前不可用。`);
    }

    console.log(`✓ ${formatAvailability(options.runtimeName, availability.details)}`);
    const models = await discoverModels(probeRuntime, options.runtimeName);
    const selectedModel = await promptForModel(terminal, models);
    const effectiveModel = selectedModel ?? models.find((model) => model.default);
    const selectedThinkingLevel = await promptForThinkingLevel(terminal, effectiveModel);
    const runtime = options.createRuntime({
      ...(selectedModel === undefined ? {} : { modelName: selectedModel.id }),
      ...(selectedThinkingLevel === undefined
        ? {}
        : { thinkingLevel: selectedThinkingLevel.value }),
    });
    const contextSystem = createRuntimeTestContextSystem();
    const expert = await defineExpert({
      id: options.expertId,
      name: `${options.runtimeName} Context Expert`,
      description: `Interactive ${options.runtimeName} runtime example with in-memory context`,
      instructions: [
        "You are a concise and friendly assistant.",
        "Answer in the same language as the user unless asked otherwise.",
        "Use earlier messages in this session when they are relevant.",
        "When the user asks about test reference material, use the Pragma context tools.",
        "Read the requested context instead of guessing from its description.",
      ].join("\n"),
      tags: ["example", "runtime", "context"],
      version: "1.0.0",
      scope: "example",
      workspace: process.cwd(),
      contextSystem,
      ...(process.env["PRAGMA_RUNTIME_DEBUG"] === "1"
        ? { loggerProvider: createConsoleLoggerProvider() }
        : {}),
    });
    const app = createPragma({
      runtimes: createRuntimeRegistry({
        runtimes: [runtime],
        defaultRuntime: runtime.descriptor.id,
      }),
    });
    session = await app.experts.createSession(expert, { runtime: runtime.descriptor.id });

    console.log(`\n${options.runtimeName} Expert 已就绪。输入问题开始聊天，输入 /exit 退出。`);
    console.log("可测试：分别询问 always-on、model-decision 和 manual 测试上下文。");
    console.log(`模型: ${selectedModel?.displayName ?? "CLI 默认模型"}`);
    console.log(`思考深度: ${selectedThinkingLevel?.label ?? "CLI 默认深度"}`);
    console.log(`Session: ${session.sessionId}`);

    let turnNumber = 0;
    terminal.setPrompt("你 > ");
    terminal.prompt();

    for await (const line of terminal) {
      const prompt = line.trim();
      if (prompt === "/exit") {
        console.log(formatConsoleUsage(await session.getUsage()));
        break;
      }
      if (prompt === "") {
        terminal.prompt();
        continue;
      }

      turnNumber += 1;
      try {
        const turn = await session.prompt(prompt, { requestId: `console-${turnNumber}` });
        await renderExpertTurn(turn);
      } catch {
        // renderExpertTurn already displayed the failure with the streamed turn output.
      }
      terminal.prompt();
    }
  } catch (error) {
    console.error(`× ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    terminal.close();
    await session?.close("Console chat ended.");
  }
}

export function selectRuntimeModel(
  models: readonly RuntimeModel[],
  answer: string,
): RuntimeModel | undefined {
  const normalized = answer.trim();
  if (normalized === "") return undefined;

  const selectedIndex = Number(normalized);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > models.length) {
    throw new Error(`请输入 1-${models.length}，或直接回车使用 CLI 默认模型。`);
  }

  return models[selectedIndex - 1];
}

export function selectRuntimeThinkingLevel(
  levels: readonly RuntimeThinkingLevel[],
  answer: string,
): RuntimeThinkingLevel | undefined {
  const normalized = answer.trim();
  if (normalized === "") return undefined;

  const selectedIndex = Number(normalized);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > levels.length) {
    throw new Error(`请输入 1-${levels.length}，或直接回车使用 CLI 默认思考深度。`);
  }

  return levels[selectedIndex - 1];
}

async function discoverModels(
  runtime: RuntimeAdapter,
  runtimeName: string,
): Promise<readonly RuntimeModel[]> {
  if (runtime.listModels === undefined) {
    throw new Error(`${runtimeName} runtime 不支持模型探测。`);
  }

  console.log("正在探测可用模型...");
  const models = await runtime.listModels();
  if (models.length === 0) {
    throw new Error(`${runtimeName} 没有返回可用模型。`);
  }
  return models;
}

async function promptForModel(
  terminal: Interface,
  models: readonly RuntimeModel[],
): Promise<RuntimeModel | undefined> {
  console.log("\n可用模型：");
  models.forEach((model, index) => {
    console.log(`  ${index + 1}. ${model.displayName} (${model.id})${model.default ? " [探测默认]" : ""}`);
  });

  while (true) {
    const answer = await terminal.question("选择模型编号，直接回车使用 CLI 默认模型 > ");
    try {
      return selectRuntimeModel(models, answer);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function promptForThinkingLevel(
  terminal: Interface,
  model: RuntimeModel | undefined,
): Promise<RuntimeThinkingLevel | undefined> {
  if (model === undefined) {
    console.log("未探测到明确的默认模型，思考深度将使用 CLI 默认值。");
    return undefined;
  }

  const levels = model.thinking?.supportedLevels ?? [];
  if (levels.length === 0) {
    console.log(`${model.displayName} 未提供可选择的思考深度，将使用 CLI 默认值。`);
    return undefined;
  }

  console.log(`\n${model.displayName} 可用思考深度：`);
  levels.forEach((level, index) => {
    const isDefault = level.value === model.thinking?.defaultLevel;
    const description = level.description === undefined ? "" : ` — ${level.description}`;
    console.log(`  ${index + 1}. ${level.label} (${level.value})${isDefault ? " [探测默认]" : ""}${description}`);
  });

  while (true) {
    const answer = await terminal.question("选择思考深度编号，直接回车使用 CLI 默认深度 > ");
    try {
      return selectRuntimeThinkingLevel(levels, answer);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

export function createRuntimeTestContextSystem(): ContextSystem {
  return new ContextSystem({
    store: createInMemoryContextStore({
      context: [
        {
          id: "runtime-test/always-on.md",
          content: [
            "# Always-on runtime context",
            "",
            "- Always-on marker: AO-2048",
            "- Runtime examples should answer in the user's language.",
            "",
            "This content is preloaded into every turn without requiring a context tool call.",
          ].join("\n"),
          metadata: {
            description: "Automatically preloaded facts for validating always-on context",
            trigger: "always_on",
            trustLevel: "user",
            priority: "high",
          },
        },
        {
          id: "runtime-test/model-decision.md",
          content: [
            "# Model-decision runtime context",
            "",
            "- Model-decision marker: MD-4096",
            "- Support channel: #runtime-examples",
            "",
            "The model should load this content when the user's request makes it relevant.",
          ].join("\n"),
          metadata: {
            description: "On-demand support facts for validating model-decided context loading",
            trigger: "model_decision",
            trustLevel: "user",
            priority: "normal",
          },
        },
        {
          id: "runtime-test/verification.md",
          content: [
            "# Runtime verification reference",
            "",
            "- Verification code: 7319",
            "- Release codename: Aurora Finch",
            "- Maintainer: Pragma Examples Team",
            "",
            "When reporting these values, state that they came from the in-memory Context Store.",
          ].join("\n"),
          metadata: {
            description: "Test-only verification facts for validating Context Store tool loading",
            trigger: "manual",
            trustLevel: "user",
            priority: "normal",
          },
        },
      ],
    }),
  });
}

function formatAvailability(
  runtimeName: string,
  details: Readonly<Record<string, unknown>> | undefined,
): string {
  const version = typeof details?.["version"] === "string" ? details["version"] : undefined;
  const executablePath =
    typeof details?.["executablePath"] === "string" ? details["executablePath"] : undefined;
  const suffix = [version, executablePath].filter((value) => value !== undefined).join(" · ");
  return suffix === "" ? `${runtimeName} 可用` : `${runtimeName} 可用 · ${suffix}`;
}
