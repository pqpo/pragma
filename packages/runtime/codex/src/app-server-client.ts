import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ExpertAgentHumanInteractionHandler } from "@pragma/core";
import type { CodexRuntimeClientInfo, CodexRuntimeSpawn, CodexUserInput } from "./types.ts";

export interface CodexAppServerClientOptions {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly clientInfo: CodexRuntimeClientInfo;
  readonly spawn?: CodexRuntimeSpawn | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly onNotification?: ((notification: CodexAppServerNotification) => void) | undefined;
  readonly onStderr?: ((chunk: string) => void) | undefined;
}

export interface CodexAppServerNotification {
  readonly method: string;
  readonly params: JsonObject;
}

export interface CodexThreadStartOptions {
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly developerInstructions?: string | undefined;
  readonly sandboxMode?: string | undefined;
  readonly approvalPolicy?: string | undefined;
}

export interface CodexTurnStartOptions {
  readonly threadId: string;
  readonly input: readonly CodexUserInput[];
  readonly model?: string | undefined;
  readonly thinkingLevel?: string | undefined;
}

export type JsonObject = Record<string, unknown>;

type JsonRpcMessage = JsonObject & {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class CodexAppServerClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  private constructor(
    process: ChildProcessWithoutNullStreams,
    private readonly options: CodexAppServerClientOptions,
  ) {
    this.process = process;
    const lines = createInterface({ input: process.stdout });

    lines.on("line", (line) => {
      this.handleLine(line);
    });
    lines.on("close", () => {
      this.rejectAll(new Error("Codex app-server stdout closed."));
    });
    process.stderr.on("data", (chunk: Buffer | string) => {
      options.onStderr?.(String(chunk));
    });
    process.on("error", (error) => {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    process.on("exit", (code, signal) => {
      const detail = signal === null ? `code ${code ?? "unknown"}` : `signal ${signal}`;
      this.rejectAll(new Error(`Codex app-server exited with ${detail}.`));
    });
  }

  static async start(options: CodexAppServerClientOptions): Promise<CodexAppServerClient> {
    const spawn = options.spawn ?? defaultSpawn;
    const process = spawn(options.executablePath, options.args, {
      cwd: options.cwd,
      env: options.env,
    });
    let client: CodexAppServerClient | undefined;
    try {
      client = new CodexAppServerClient(process, options);
      await client.request("initialize", {
        clientInfo: options.clientInfo,
        capabilities: {
          experimentalApi: true,
        },
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      try {
        if (client === undefined) {
          process.stdin.end();
          process.kill("SIGTERM");
        } else {
          client.close();
        }
      } catch {
        process.kill("SIGKILL");
      }
      throw error;
    }
  }

  async startThread(options: CodexThreadStartOptions): Promise<string> {
    const params: JsonObject = {
      cwd: options.cwd,
      modelProvider: null,
      profile: null,
      config: null,
      baseInstructions: null,
      compactPrompt: null,
      includeApplyPatchTool: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.developerInstructions === undefined
        ? {}
        : { developerInstructions: options.developerInstructions }),
      ...(options.sandboxMode === undefined ? {} : { sandbox: options.sandboxMode }),
      ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    };
    applyThreadThinkingLevel(params, options.thinkingLevel);
    const result = await this.request("thread/start", params);
    const threadId = readThreadId(result);

    if (threadId === undefined) {
      throw new Error("Codex thread/start returned no thread id.");
    }

    return threadId;
  }

  async resumeThread(threadId: string, options: CodexThreadStartOptions): Promise<string> {
    const params: JsonObject = {
      threadId,
      cwd: options.cwd,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.developerInstructions === undefined
        ? {}
        : { developerInstructions: options.developerInstructions }),
    };
    applyThreadThinkingLevel(params, options.thinkingLevel);
    const result = await this.request("thread/resume", params);
    return readThreadId(result) ?? threadId;
  }

  async startTurn(options: CodexTurnStartOptions): Promise<unknown> {
    return await this.request("turn/start", {
      threadId: options.threadId,
      input: options.input,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinkingLevel === undefined ? {} : { effort: options.thinkingLevel }),
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId });
  }

  async steerTurn(options: {
    readonly threadId: string;
    readonly expectedTurnId: string;
    readonly requestId: string;
    readonly input: readonly CodexUserInput[];
  }): Promise<void> {
    await this.request("turn/steer", {
      threadId: options.threadId,
      expectedTurnId: options.expectedTurnId,
      clientUserMessageId: options.requestId,
      input: options.input,
    });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.request("thread/compact/start", { threadId });
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.process.stdin.end();
    this.process.kill("SIGTERM");
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server client is closed."));
    }

    const id = this.nextId++;
    const message = { id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      void this.writeMessage(message).catch((error: unknown) => {
        if (this.pending.delete(id)) {
          reject(toError(error));
        }
      });
    });
  }

  private notify(method: string, params: JsonObject): void {
    if (this.closed) {
      return;
    }

    void this.writeMessage({ method, params }).catch((error: unknown) => {
      this.rejectAll(toError(error));
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();

    if (trimmed === "") {
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && typeof message.method === "string") {
      void this.handleServerRequest(message.id, message.method, toJsonObject(message.params)).catch(
        (error: unknown) => {
          this.rejectAll(toError(error));
        },
      );
      return;
    }

    if (message.id !== undefined) {
      this.handleResponse(message);
      return;
    }

    if (typeof message.method === "string") {
      this.options.onNotification?.({
        method: message.method,
        params: toJsonObject(message.params),
      });
    }
  }

  private handleResponse(message: JsonRpcMessage): void {
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const pending = this.pending.get(id);

    if (pending === undefined) {
      return;
    }

    this.pending.delete(id);

    if (message.error !== undefined) {
      pending.reject(createRpcError(pending.method, message.error));
      return;
    }

    pending.resolve(message.result);
  }

  private async handleServerRequest(
    id: unknown,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    const numericId = typeof id === "number" ? id : Number(id);

    if (!Number.isInteger(numericId)) {
      return;
    }

    try {
      const result = await this.createServerRequestResponse(method, params);
      await this.writeMessage({ id: numericId, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeMessage({
        id: numericId,
        error: {
          code: -32603,
          message,
        },
      });
    }
  }

  private writeMessage(message: JsonObject): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server client is closed."));
    }

    return new Promise<void>((resolve, reject) => {
      let line: string;

      try {
        line = `${JSON.stringify(message)}\n`;
      } catch (error) {
        reject(toError(error));
        return;
      }

      this.process.stdin.write(line, (error) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async createServerRequestResponse(
    method: string,
    params: JsonObject,
  ): Promise<JsonObject> {
    if (method === "mcpServer/elicitation/request") {
      return { action: "decline", content: null, _meta: null };
    }

    const handler = this.options.humanInteractionHandler;

    if (handler === undefined) {
      return { decision: "reject", reason: "No approval handler is configured." };
    }

    const response = await handler({
      kind: "tool_approval",
      toolName: method,
      input: params,
      reason: "Codex requested runtime approval.",
    });

    if (response.kind !== "tool_approval" || !response.approved) {
      return { decision: "reject", reason: response.reason ?? "Approval denied." };
    }

    return createApprovedServerRequestResponse(method, params);
  }

  private rejectAll(error: Error): void {
    if (this.pending.size === 0) {
      return;
    }

    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    this.pending.clear();
  }
}

function applyThreadThinkingLevel(params: JsonObject, thinkingLevel: string | undefined): void {
  if (thinkingLevel === undefined) {
    return;
  }

  const config =
    params["config"] !== null && typeof params["config"] === "object"
      ? (params["config"] as JsonObject)
      : {};
  config["model_reasoning_effort"] = thinkingLevel;
  params["config"] = config;
}

function createApprovedServerRequestResponse(method: string, params: JsonObject): JsonObject {
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: readRecord(params["permissions"]) ?? {},
      scope: "turn",
    };
  }

  return { decision: "accept" };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
): ChildProcessWithoutNullStreams {
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
  });
}

function readThreadId(result: unknown): string | undefined {
  const record = readRecord(result);
  const directThread = readRecord(record?.["thread"]);
  const nestedThread = readRecord(readRecord(record?.["result"])?.["thread"]);
  const candidates = [
    record?.["threadId"],
    record?.["id"],
    directThread?.["id"],
    nestedThread?.["id"],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }

  return undefined;
}

function createRpcError(method: string, error: unknown): Error {
  const record = readRecord(error);
  const message =
    typeof record?.["message"] === "string"
      ? record["message"]
      : "Codex app-server request failed.";
  const code = record?.["code"];
  const suffix = typeof code === "number" || typeof code === "string" ? ` (code=${code})` : "";
  return new Error(`${method}: ${message}${suffix}`);
}

function toJsonObject(value: unknown): JsonObject {
  return readRecord(value) ?? {};
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readRecord(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonObject;
}
