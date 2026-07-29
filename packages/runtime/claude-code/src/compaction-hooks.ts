import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { RuntimeContextCompactionStage, RuntimeContextCompactionTrigger } from "@pragma/core";
import { RUNTIME_CONTEXT_COMPACTION_STAGES } from "@pragma/core";

const MAX_HOOK_BODY_BYTES = 64 * 1024;

export interface ClaudeCompactionNativeEvent extends Record<string, unknown> {
  readonly type: "pragma_context_compaction";
  readonly operationId: string;
  readonly stage: RuntimeContextCompactionStage;
  readonly trigger: RuntimeContextCompactionTrigger;
  readonly errorMessage?: string | undefined;
}

export interface ClaudeCompactionHookRelay {
  readonly url: string;
  readonly authorization: string;
  readonly subscribe: (subscriber: (event: ClaudeCompactionNativeEvent) => void) => () => void;
  readonly failPending: (message: string) => void;
  readonly close: () => Promise<void>;
}

export async function createClaudeCompactionHookRelay(): Promise<ClaudeCompactionHookRelay> {
  const token = randomBytes(32).toString("base64url");
  const authorization = `Bearer ${token}`;
  const subscribers = new Set<(event: ClaudeCompactionNativeEvent) => void>();
  const pending = new Map<
    string,
    { readonly operationId: string; readonly trigger: RuntimeContextCompactionTrigger }
  >();
  const publish = (event: ClaudeCompactionNativeEvent): void => {
    for (const subscriber of subscribers) subscriber(event);
  };
  const server = createServer((request, response) => {
    void handleHookRequest({
      request,
      response,
      authorization,
      pending,
      publish,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Claude Code compaction hook relay did not bind a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/context-compaction`,
    authorization,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    failPending(message) {
      for (const { operationId, trigger } of pending.values()) {
        publish({
          type: "pragma_context_compaction",
          operationId,
          stage: RUNTIME_CONTEXT_COMPACTION_STAGES.failed,
          trigger,
          errorMessage: message,
        });
      }
      pending.clear();
    },
    async close() {
      subscribers.clear();
      pending.clear();
      await closeServer(server);
    },
  };
}

async function handleHookRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly authorization: string;
  readonly pending: Map<
    string,
    { readonly operationId: string; readonly trigger: RuntimeContextCompactionTrigger }
  >;
  readonly publish: (event: ClaudeCompactionNativeEvent) => void;
}): Promise<void> {
  const { request, response } = options;
  try {
    if (
      request.method !== "POST" ||
      request.url !== "/context-compaction" ||
      !matchesSecret(request.headers.authorization, options.authorization)
    ) {
      response.writeHead(404).end();
      return;
    }
    const payload = asRecord(JSON.parse(await readRequestBody(request)) as unknown);
    const hookEventName = readString(payload?.["hook_event_name"]);
    const sessionId = readString(payload?.["session_id"]);
    if (
      sessionId === undefined ||
      (hookEventName !== "PreCompact" && hookEventName !== "PostCompact")
    ) {
      response.writeHead(400).end();
      return;
    }
    const trigger = readTrigger(payload?.["trigger"]);
    if (hookEventName === "PreCompact") {
      const operationId = randomUUID();
      options.pending.set(sessionId, { operationId, trigger });
      options.publish({
        type: "pragma_context_compaction",
        operationId,
        stage: RUNTIME_CONTEXT_COMPACTION_STAGES.started,
        trigger,
      });
    } else {
      const current = options.pending.get(sessionId) ?? {
        operationId: randomUUID(),
        trigger,
      };
      options.pending.delete(sessionId);
      options.publish({
        type: "pragma_context_compaction",
        operationId: current.operationId,
        stage: RUNTIME_CONTEXT_COMPACTION_STAGES.completed,
        trigger: current.trigger,
      });
    }
    response.writeHead(204).end();
  } catch {
    response.writeHead(400).end();
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HOOK_BODY_BYTES) throw new Error("Claude hook body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function matchesSecret(value: string | undefined, expected: string): boolean {
  if (value === undefined) return false;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function readTrigger(value: unknown): RuntimeContextCompactionTrigger {
  return value === "auto" || value === "manual" ? value : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
