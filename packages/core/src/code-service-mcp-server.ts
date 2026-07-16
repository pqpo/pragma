import { Worker } from "node:worker_threads";

import { Validator, type Schema } from "@cfworker/json-schema";

import type {
  IExpertAgentInProcessMcpServer,
  IExpertAgentMcpToolInfo,
} from "./agent/expert-agent.ts";

export interface CodeServiceToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly source: string;
}

export interface CodeServiceDefinition {
  readonly name: string;
  readonly tool: CodeServiceToolDefinition;
  readonly timeoutMs?: number | undefined;
}

export type CodeServiceToolErrorCode =
  | "invalid_input"
  | "compile_error"
  | "runtime_error"
  | "timeout"
  | "memory_limit"
  | "invalid_output"
  | "output_too_large"
  | "aborted";

export interface CodeServiceToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown> | undefined;
  readonly isError?: boolean | undefined;
  readonly details?:
    | {
        readonly code: CodeServiceToolErrorCode;
        readonly service: string;
        readonly tool: string;
      }
    | undefined;
}

export interface CodeServiceVerificationResult {
  readonly ok: boolean;
  readonly code: "ready" | CodeServiceToolErrorCode;
  readonly message: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const STACK_LIMIT_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_CONCURRENT_WORKERS = 4;
const MAX_QUEUED_EXECUTIONS = 32;
const WORKER_STARTUP_TIMEOUT_MS = 30_000;

type CodeExecutionResult =
  | { readonly ok: true; readonly code: "ready"; readonly message: string; readonly json: string }
  | {
      readonly ok: false;
      readonly code: CodeServiceToolErrorCode;
      readonly message: string;
    };

interface ExecutionSlotWaiter {
  readonly resolve: (result: "acquired" | "aborted") => void;
  readonly signal?: AbortSignal | undefined;
  readonly abort: () => void;
}

let activeWorkers = 0;
const executionWaiters: ExecutionSlotWaiter[] = [];

export function createCodeServiceMcpServer(
  definition: CodeServiceDefinition,
): IExpertAgentInProcessMcpServer {
  const inputValidator = createValidator(definition.tool.inputSchema);
  const outputValidator = createValidator(definition.tool.outputSchema);

  return {
    async listTools(): Promise<readonly IExpertAgentMcpToolInfo[]> {
      return [
        {
          name: definition.tool.name,
          description: definition.tool.description,
          inputSchema: definition.tool.inputSchema,
          outputSchema: definition.tool.outputSchema,
        },
      ];
    },
    async callTool(name, args, signal): Promise<CodeServiceToolResult> {
      if (name !== definition.tool.name) {
        return errorResult(definition, "invalid_input", `Unknown code tool: ${name}.`);
      }

      let inputJson: string | undefined;
      try {
        inputJson = JSON.stringify(args);
      } catch {
        inputJson = undefined;
      }
      if (inputJson === undefined || byteLength(inputJson) > MAX_JSON_BYTES) {
        return errorResult(
          definition,
          "invalid_input",
          "Tool input must be JSON and no larger than 1 MiB.",
        );
      }

      const inputValidation = inputValidator.validate(args);
      if (!inputValidation.valid) {
        return errorResult(
          definition,
          "invalid_input",
          validationMessage("Tool input", inputValidation.errors),
        );
      }

      const execution = await executeCode({
        source: definition.tool.source,
        inputJson,
        timeoutMs: definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal,
        invokeMain: true,
      });
      if (!execution.ok) {
        return errorResult(definition, execution.code, execution.message);
      }

      if (byteLength(execution.json) > MAX_JSON_BYTES) {
        return errorResult(
          definition,
          "output_too_large",
          "Code service output exceeded the 1 MiB limit.",
        );
      }

      let output: unknown;
      try {
        output = JSON.parse(execution.json) as unknown;
      } catch {
        return errorResult(definition, "invalid_output", "Code service output was not valid JSON.");
      }
      if (!isRecord(output)) {
        return errorResult(definition, "invalid_output", "Code service output must be an object.");
      }

      const outputValidation = outputValidator.validate(output);
      if (!outputValidation.valid) {
        return errorResult(
          definition,
          "invalid_output",
          validationMessage("Tool output", outputValidation.errors),
        );
      }

      return {
        content: [{ type: "text", text: execution.json }],
        structuredContent: output,
      };
    },
  };
}

export async function verifyCodeServiceDefinition(
  definition: CodeServiceDefinition,
  signal?: AbortSignal,
): Promise<CodeServiceVerificationResult> {
  try {
    createValidator(definition.tool.inputSchema);
    createValidator(definition.tool.outputSchema);
  } catch (error) {
    return {
      ok: false,
      code: "compile_error",
      message: sanitizeMessage(error, "The code service schema is invalid."),
    };
  }

  const execution = await executeCode({
    source: definition.tool.source,
    inputJson: "{}",
    timeoutMs: definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal,
    invokeMain: false,
  });
  return execution.ok
    ? { ok: true, code: "ready", message: "The code service is ready." }
    : execution;
}

function createValidator(schema: Record<string, unknown>): Validator {
  return new Validator(schema as Schema, "2020-12", false);
}

async function executeCode(options: {
  readonly source: string;
  readonly inputJson: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly invokeMain: boolean;
}): Promise<CodeExecutionResult> {
  const slot = await acquireExecutionSlot(options.signal);
  if (slot === "aborted") {
    return { ok: false, code: "aborted", message: "Code service execution was cancelled." };
  }
  if (slot === "busy") {
    return {
      ok: false,
      code: "runtime_error",
      message: "Code service execution capacity is currently exhausted.",
    };
  }

  try {
    return await executeInWorker(options);
  } finally {
    releaseExecutionSlot();
  }
}

async function acquireExecutionSlot(
  signal: AbortSignal | undefined,
): Promise<"acquired" | "aborted" | "busy"> {
  if (signal?.aborted === true) return "aborted";
  if (activeWorkers < MAX_CONCURRENT_WORKERS) {
    activeWorkers += 1;
    return "acquired";
  }
  if (executionWaiters.length >= MAX_QUEUED_EXECUTIONS) return "busy";

  return await new Promise<"acquired" | "aborted">((resolve) => {
    const waiter: ExecutionSlotWaiter = {
      resolve,
      signal,
      abort: () => {
        const index = executionWaiters.indexOf(waiter);
        if (index >= 0) executionWaiters.splice(index, 1);
        signal?.removeEventListener("abort", waiter.abort);
        resolve("aborted");
      },
    };
    signal?.addEventListener("abort", waiter.abort, { once: true });
    executionWaiters.push(waiter);
    if (signal?.aborted === true) waiter.abort();
  });
}

function releaseExecutionSlot(): void {
  const waiter = executionWaiters.shift();
  if (waiter === undefined) {
    activeWorkers -= 1;
    return;
  }
  waiter.signal?.removeEventListener("abort", waiter.abort);
  waiter.resolve("acquired");
}

async function executeInWorker(options: {
  readonly source: string;
  readonly inputJson: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly invokeMain: boolean;
}): Promise<CodeExecutionResult> {
  const worker = new Worker(codeServiceWorkerUrl(), {
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  });

  return await new Promise<CodeExecutionResult>((resolve) => {
    let settled = false;
    let executionTimer: ReturnType<typeof setTimeout> | undefined;
    const startupTimer = setTimeout(() => {
      finish({
        ok: false,
        code: "runtime_error",
        message: "The isolated code service runtime did not start in time.",
      });
    }, WORKER_STARTUP_TIMEOUT_MS);
    const abort = () =>
      finish({ ok: false, code: "aborted", message: "Code service execution was cancelled." });
    const finish = (result: CodeExecutionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (executionTimer !== undefined) clearTimeout(executionTimer);
      options.signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
      void worker
        .terminate()
        .catch(() => undefined)
        .then(() => resolve(result));
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) {
      abort();
      return;
    }
    worker.on("message", (message: unknown) => {
      if (isWorkerReadyMessage(message)) {
        clearTimeout(startupTimer);
        executionTimer = setTimeout(
          () =>
            finish({
              ok: false,
              code: "timeout",
              message: "Code service execution timed out.",
            }),
          options.timeoutMs,
        );
        worker.postMessage({
          type: "execute",
          source: options.source,
          inputJson: options.inputJson,
          timeoutMs: options.timeoutMs,
          invokeMain: options.invokeMain,
          memoryLimitBytes: MEMORY_LIMIT_BYTES,
          stackLimitBytes: STACK_LIMIT_BYTES,
        });
        return;
      }
      if (isWorkerResultMessage(message)) finish(message.result);
    });
    worker.on("error", (error) =>
      finish({
        ok: false,
        code: "runtime_error",
        message: sanitizeMessage(error, "The isolated code service runtime failed."),
      }),
    );
    worker.on("exit", () =>
      finish({
        ok: false,
        code: "runtime_error",
        message: "The isolated code service runtime exited unexpectedly.",
      }),
    );
  });
}

function codeServiceWorkerUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./code-service-worker.${extension}`, import.meta.url);
}

function isWorkerReadyMessage(value: unknown): value is { readonly type: "ready" } {
  return isRecord(value) && value["type"] === "ready";
}

function isWorkerResultMessage(
  value: unknown,
): value is { readonly type: "result"; readonly result: CodeExecutionResult } {
  if (!isRecord(value) || value["type"] !== "result" || !isRecord(value["result"])) return false;
  const result = value["result"];
  return (
    typeof result["ok"] === "boolean" &&
    typeof result["code"] === "string" &&
    typeof result["message"] === "string" &&
    (result["ok"] === false || typeof result["json"] === "string")
  );
}

function validationMessage(
  label: string,
  errors: readonly { readonly instanceLocation: string; readonly error: string }[],
): string {
  const issue = errors[0];
  if (issue === undefined) return `${label} does not match its JSON Schema.`;
  const location = issue.instanceLocation || "/";
  return `${label} ${location}: ${issue.error}`.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function errorResult(
  definition: CodeServiceDefinition,
  code: CodeServiceToolErrorCode,
  message: string,
): CodeServiceToolResult {
  return {
    content: [{ type: "text", text: message.slice(0, MAX_ERROR_MESSAGE_LENGTH) }],
    isError: true,
    details: { code, service: definition.name, tool: definition.tool.name },
  };
}

function sanitizeMessage(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
