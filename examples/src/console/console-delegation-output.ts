import { parseArgs } from "node:util";

import type { ExecutionOutputItem, ExpertTurn, InvocationScope } from "@pragma/core";

interface ConsoleOutput {
  write(text: string): unknown;
}

type ExpertOutputItem = ExecutionOutputItem;

export type DelegationStreamMode =
  | { readonly kind: "root" }
  | { readonly kind: "all" }
  | { readonly kind: "executor"; readonly executorId: string }
  | { readonly kind: "invocation"; readonly invocationId: string };

export function parseDelegationStreamMode(args: readonly string[]): DelegationStreamMode {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const { values } = parseArgs({
    args: [...normalizedArgs],
    options: {
      stream: { type: "string", default: "main" },
      executor: { type: "string" },
      invocation: { type: "string" },
    },
    strict: true,
  });
  if (values.executor !== undefined && values.invocation !== undefined) {
    throw new Error("Use only one of --executor or --invocation.");
  }
  if (values.executor !== undefined) return { kind: "executor", executorId: values.executor };
  if (values.invocation !== undefined)
    return { kind: "invocation", invocationId: values.invocation };
  const mode = values.stream;
  if (mode === "main") return { kind: "root" };
  if (mode === "all") return { kind: "all" };
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
  const source = await turn.subscribeOutput({ scope: options.mode satisfies InvocationScope });
  const labels = new Map<string, string>();
  const invocationsWithAnswers = new Set<string>();
  let activeSection: string | undefined;
  let rendered = false;

  try {
    for await (const item of source) {
      const text = readOutputText(item, invocationsWithAnswers);
      if (text === undefined || text === "") continue;
      const label = item.executorId ?? (await readInvocationLabel(turn, item.invocationId, labels));
      const section = `${item.invocationId}:${item.channel}`;
      if (section !== activeSection) {
        if (rendered) output.write("\n");
        output.write(`[${label} · ${formatChannel(item.channel)}]\n`);
        activeSection = section;
      }
      output.write(text);
      rendered = true;
    }
  } finally {
    await source.close();
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
    const text = readCompletedMessageText(item.value);
    if (text === undefined || text === "") return undefined;
    invocationsWithAnswers.add(item.invocationId);
    return text;
  }
  if (item.channel === "result") {
    return invocationsWithAnswers.has(item.invocationId) ? undefined : formatValue(item.value);
  }
  return item.delta ?? formatValue(item.value);
}

function readCompletedMessageText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const content = (value as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      if (typeof item !== "object" || item === null) return undefined;
      const record = item as Record<string, unknown>;
      return record["type"] === "text" && typeof record["text"] === "string"
        ? record["text"]
        : undefined;
    })
    .filter((item): item is string => item !== undefined)
    .join("");
  return text === "" ? undefined : text;
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
