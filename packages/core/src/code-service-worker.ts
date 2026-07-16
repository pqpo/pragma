import { parentPort } from "node:worker_threads";

import {
  isFail,
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

type CodeServiceToolErrorCode =
  | "compile_error"
  | "runtime_error"
  | "timeout"
  | "memory_limit"
  | "invalid_output";

type CodeExecutionResult =
  | { readonly ok: true; readonly code: "ready"; readonly message: string; readonly json: string }
  | {
      readonly ok: false;
      readonly code: CodeServiceToolErrorCode;
      readonly message: string;
    };

interface ExecuteMessage {
  readonly type: "execute";
  readonly source: string;
  readonly inputJson: string;
  readonly timeoutMs: number;
  readonly invokeMain: boolean;
  readonly memoryLimitBytes: number;
  readonly stackLimitBytes: number;
}

const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const port = parentPort;

if (port === null) {
  throw new Error("Code service worker requires a parent port.");
}

const quickJsModule = newQuickJSWASMModuleFromVariant(
  import("@jitl/quickjs-singlefile-cjs-release-sync"),
);

void quickJsModule
  .then((quickJs) => {
    port.postMessage({ type: "ready" });
    port.once("message", (message: unknown) => {
      if (!isExecuteMessage(message)) {
        port.postMessage({
          type: "result",
          result: {
            ok: false,
            code: "runtime_error",
            message: "The isolated code service runtime received an invalid request.",
          } satisfies CodeExecutionResult,
        });
        return;
      }
      port.postMessage({ type: "result", result: executeCode(quickJs, message) });
    });
  })
  .catch((error: unknown) => {
    port.postMessage({
      type: "result",
      result: {
        ok: false,
        code: "runtime_error",
        message: sanitizeMessage(error, "The isolated code service runtime failed to start."),
      } satisfies CodeExecutionResult,
    });
  });

function executeCode(quickJs: QuickJSWASMModule, options: ExecuteMessage): CodeExecutionResult {
  const runtime = quickJs.newRuntime();
  runtime.setMemoryLimit(options.memoryLimitBytes);
  runtime.setMaxStackSize(options.stackLimitBytes);
  runtime.removeModuleLoader();
  const deadline = Date.now() + options.timeoutMs;
  let timedOut = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() < deadline) return false;
    timedOut = true;
    return true;
  });
  const context = runtime.newContext();

  try {
    const result = context.evalCode(
      createProgram(options.source, options.inputJson, options.invokeMain),
      "pragma-code-service.js",
      { type: "global", strict: true },
    );
    if (isFail(result)) {
      const message = readQuickJsError(context, result.error);
      result.error.dispose();
      if (timedOut) {
        return { ok: false, code: "timeout", message: "Code service execution timed out." };
      }
      return {
        ok: false,
        code: classifyExecutionError(message, options.invokeMain),
        message,
      };
    }

    const value = context.dump(result.value) as unknown;
    result.value.dispose();
    if (typeof value !== "string") {
      return {
        ok: false,
        code: options.invokeMain ? "invalid_output" : "compile_error",
        message: options.invokeMain
          ? "The main function did not return JSON output."
          : "The code service must define function main(input).",
      };
    }
    return { ok: true, code: "ready", message: "The code service is ready.", json: value };
  } catch (error) {
    const message = sanitizeMessage(error, "Code service execution failed.");
    return {
      ok: false,
      code: message.toLowerCase().includes("memory") ? "memory_limit" : "runtime_error",
      message,
    };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

function createProgram(source: string, inputJson: string, invokeMain: boolean): string {
  const invocation = invokeMain
    ? `
      const __pragmaResult = __pragmaMain(JSON.parse(${JSON.stringify(inputJson)}));
      if (__pragmaResult !== null && typeof __pragmaResult === "object" &&
          typeof __pragmaResult.then === "function") {
        throw new TypeError("main(input) must return synchronously.");
      }
      const __pragmaJson = JSON.stringify(__pragmaResult);
      if (typeof __pragmaJson !== "string") {
        throw new TypeError("main(input) must return a JSON value.");
      }
      return __pragmaJson;
    `
    : `return "ready";`;

  return `
    (() => {
      "use strict";
      const __pragmaMain = (() => {
        ${source}
        return typeof main === "function" ? main : undefined;
      })();
      if (typeof __pragmaMain !== "function") {
        throw new TypeError("The code service must define function main(input).");
      }
      ${invocation}
    })()
  `;
}

function readQuickJsError(
  context: QuickJSContext,
  handle: Parameters<QuickJSContext["dump"]>[0],
): string {
  const value = context.dump(handle) as unknown;
  if (isRecord(value)) {
    const name = typeof value["name"] === "string" ? value["name"] : "Error";
    const message = typeof value["message"] === "string" ? value["message"] : String(value);
    return `${name}: ${message}`.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  }
  return String(value).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function classifyExecutionError(message: string, invokedMain: boolean): CodeServiceToolErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes("out of memory") || lower.includes("memory limit")) return "memory_limit";
  if (lower.includes("must return") || lower.includes("json")) return "invalid_output";
  if (!invokedMain || lower.includes("syntax") || lower.includes("define function main")) {
    return "compile_error";
  }
  return "runtime_error";
}

function isExecuteMessage(value: unknown): value is ExecuteMessage {
  if (!isRecord(value) || value["type"] !== "execute") return false;
  return (
    typeof value["source"] === "string" &&
    typeof value["inputJson"] === "string" &&
    typeof value["timeoutMs"] === "number" &&
    typeof value["invokeMain"] === "boolean" &&
    typeof value["memoryLimitBytes"] === "number" &&
    typeof value["stackLimitBytes"] === "number"
  );
}

function sanitizeMessage(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
