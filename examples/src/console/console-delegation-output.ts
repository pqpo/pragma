import { parseArgs } from "node:util";

import type { ExpertTurn } from "@pragma/core";

interface ConsoleOutput {
  write(text: string): unknown;
}

type ExpertOutputItem = ReturnType<ExpertTurn["getAllOutput"]> extends AsyncIterable<infer TItem>
  ? TItem
  : never;

export type DelegationStreamMode = "main" | "all";

export function parseDelegationStreamMode(args: readonly string[]): DelegationStreamMode {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const { values } = parseArgs({
    args: [...normalizedArgs],
    options: {
      stream: { type: "string", default: "main" },
    },
    strict: true,
  });
  const mode = values.stream;
  if (mode === "main" || mode === "all") return mode;
  throw new Error(`Invalid --stream value: ${mode}. Expected "main" or "all".`);
}

export async function renderDelegationOutput(
  turn: ExpertTurn,
  options: {
    readonly mode: DelegationStreamMode;
    readonly output?: ConsoleOutput | undefined;
  },
): Promise<unknown> {
  const output = options.output ?? process.stdout;
  const source = options.mode === "all" ? turn.getAllOutput() : turn.getRootOutput();
  const labels = new Map<string, string>();
  const invocationsWithAnswers = new Set<string>();
  let activeSection: string | undefined;
  let rendered = false;

  for await (const item of source) {
    const text = readOutputText(item, invocationsWithAnswers);
    if (text === undefined || text === "") continue;
    const label = await readInvocationLabel(turn, item.invocationId, labels);
    const section = `${item.invocationId}:${item.channel}`;
    if (section !== activeSection) {
      if (rendered) output.write("\n");
      output.write(`[${label} · ${formatChannel(item.channel)}]\n`);
      activeSection = section;
    }
    output.write(text);
    rendered = true;
  }

  if (rendered) output.write("\n");
  return await turn.result;
}

function readOutputText(
  item: ExpertOutputItem,
  invocationsWithAnswers: Set<string>,
): string | undefined {
  if (item.channel === "progress" || item.channel === "tool") return undefined;
  if (item.channel === "message") {
    if (item.delta !== undefined) {
      invocationsWithAnswers.add(item.invocationId);
      return item.delta;
    }
    if (invocationsWithAnswers.has(item.invocationId)) return undefined;
    invocationsWithAnswers.add(item.invocationId);
    return formatValue(item.value);
  }
  if (item.channel === "result") {
    return invocationsWithAnswers.has(item.invocationId) ? undefined : formatValue(item.value);
  }
  return item.delta ?? formatValue(item.value);
}

async function readInvocationLabel(
  turn: ExpertTurn,
  invocationId: string,
  labels: Map<string, string>,
): Promise<string> {
  const existing = labels.get(invocationId);
  if (existing !== undefined) return existing;
  const invocation = await turn.getInvocation(invocationId);
  const label = invocation?.executorId ?? invocation?.definition.id ?? invocationId;
  labels.set(invocationId, label);
  return label;
}

function formatChannel(channel: ExpertOutputItem["channel"]): string {
  switch (channel) {
    case "message":
      return "answer";
    case "thought":
      return "thinking";
    case "tool":
      return "tool";
    case "result":
      return "result";
    case "progress":
      return "progress";
  }
}

function formatValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}
