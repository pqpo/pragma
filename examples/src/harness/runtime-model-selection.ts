import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { RuntimeModel } from "@pragma/core";

export interface RuntimeModelSelection {
  readonly modelName?: string | undefined;
  readonly thinkingLevel?: string | undefined;
}

export interface SelectRuntimeModelOptions {
  readonly runtimeName: string;
  readonly models: readonly RuntimeModel[];
}

export async function selectRuntimeModel(
  options: SelectRuntimeModelOptions,
): Promise<RuntimeModelSelection> {
  printDetectedModels(options.runtimeName, options.models);

  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new Error(`${options.runtimeName} model selection requires an interactive terminal.`);
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const model = await resolveModel(options.models, rl);
    const thinkingLevel = await resolveThinkingLevel(model, rl);

    return {
      ...(model === undefined ? {} : { modelName: model.id }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    };
  } finally {
    rl.close();
  }
}

function printDetectedModels(runtimeName: string, models: readonly RuntimeModel[]): void {
  console.log(`${runtimeName} detected models:`);

  for (const model of models) {
    const levels = model.thinking?.supportedLevels.map((level) => level.value).join(", ");
    console.log(
      `- ${model.id}: ${model.displayName}${model.default === true ? " [runtime default]" : ""}`,
    );
    console.log(`  thinking: ${levels === undefined || levels === "" ? "not detected" : levels}`);
  }

  console.log("");
}

async function resolveModel(
  models: readonly RuntimeModel[],
  rl: ReturnType<typeof createInterface>,
): Promise<RuntimeModel | undefined> {
  console.log("Select a model:");
  console.log("  0. Follow local CLI config");
  models.forEach((model, index) => {
    console.log(`  ${index + 1}. ${model.displayName} (${model.id})`);
  });

  return await askForModel(rl, models);
}

async function askForModel(
  rl: ReturnType<typeof createInterface>,
  models: readonly RuntimeModel[],
): Promise<RuntimeModel | undefined> {
  while (true) {
    const answer = (await rl.question("Model [0]: ")).trim();
    if (answer === "" || answer === "0") {
      return undefined;
    }

    const index = Number.parseInt(answer, 10);
    if (String(index) === answer && index >= 1 && index <= models.length) {
      return models[index - 1];
    }

    console.log(`Choose a number from 0 to ${models.length}.`);
  }
}

async function resolveThinkingLevel(
  selectedModel: RuntimeModel | undefined,
  rl: ReturnType<typeof createInterface>,
): Promise<string | undefined> {
  if (selectedModel === undefined) {
    console.log("Using the local CLI model and thinking configuration.");
    console.log("");
    return undefined;
  }

  const model = selectedModel;
  const levels = model.thinking?.supportedLevels ?? [];

  if (levels.length === 0) {
    console.log("No thinking levels were detected for the selected model; using local CLI config.");
    console.log("");
    return undefined;
  }

  console.log(`Select thinking level for ${model.displayName}:`);
  console.log("  0. Follow local CLI config");
  levels.forEach((level, index) => {
    console.log(
      `  ${index + 1}. ${level.label} (${level.value})${
        level.value === model.thinking?.defaultLevel ? " [runtime default]" : ""
      }`,
    );
  });

  while (true) {
    const answer = (await rl.question("Thinking level [0]: ")).trim();
    if (answer === "" || answer === "0") {
      return undefined;
    }

    const index = Number.parseInt(answer, 10);
    if (String(index) === answer && index >= 1 && index <= levels.length) {
      return levels[index - 1]?.value;
    }

    console.log(`Choose a number from 0 to ${levels.length}.`);
  }
}
