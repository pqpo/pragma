import { createOpencodeClient } from "@opencode-ai/sdk";
import { OpenCode } from "@opencode/client";
import { realpath } from "node:fs/promises";

import type { OpenCodeProcess } from "./process.ts";

export interface OpenCodeWireEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface OpenCodeClient {
  createSession(
    restoredId: string,
    systemPrompt: string,
    permissions: readonly OpenCodePermissionRule[],
  ): Promise<string>;
  listModels(): Promise<readonly OpenCodeModel[]>;
  serializedContext(sessionId: string): Promise<string>;
  addMcp(name: string, url: string): Promise<void>;
  prompt(input: {
    readonly sessionId: string;
    readonly text: string;
    readonly files: readonly {
      readonly uri: string;
      readonly name: string;
      readonly mimeType: string;
    }[];
    readonly model?: OpenCodeModelRef | undefined;
    readonly onEvent: (event: OpenCodeWireEvent) => Promise<void> | void;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeTurnOutput>;
  cancel(sessionId: string): Promise<void>;
  compact(sessionId: string, model?: OpenCodeModelRef): Promise<void>;
  replyPermission(sessionId: string, requestId: string, approved: boolean): Promise<void>;
  replyQuestion(
    sessionId: string,
    requestId: string,
    answers?: readonly (readonly string[])[] | Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface OpenCodeModelRef {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string | undefined;
}

export interface OpenCodeModel extends OpenCodeModelRef {
  readonly displayName: string;
  readonly providerName: string;
  readonly contextLimit?: number | undefined;
  readonly inputModalities?: readonly string[] | undefined;
  readonly variants?: readonly string[] | undefined;
  readonly isDefault?: boolean | undefined;
}

export interface OpenCodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface OpenCodeTurnOutput {
  readonly text: string;
  readonly usage?:
    | {
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheWrite: number;
      }
    | undefined;
}

export function connectOpenCode(process: OpenCodeProcess, directory: string): OpenCodeClient {
  return process.major === 1 ? connectV1(process, directory) : connectV2(process, directory);
}

function connectV1(process: OpenCodeProcess, directory: string): OpenCodeClient {
  const client = createOpencodeClient({
    baseUrl: process.url,
    directory,
    headers: { ...process.headers },
    throwOnError: true,
  });
  let systemPrompt = "";
  return {
    async createSession(restoredId, prompt) {
      systemPrompt = prompt;
      if (restoredId !== "") {
        const result = await client.session.get({ path: { id: restoredId }, query: { directory } });
        if (result.data?.id !== restoredId)
          throw new Error("OpenCode session restore returned a different ID.");
        if (!(await sameDirectory(result.data.directory, directory))) {
          throw new Error("OpenCode session restore belongs to a different workspace.");
        }
        return restoredId;
      }
      const result = await client.session.create({ body: {}, query: { directory } });
      if (result.data?.id === undefined) throw new Error("OpenCode did not create a session.");
      return result.data.id;
    },
    async listModels() {
      const result = await client.provider.list({ query: { directory } });
      const connected = new Set(result.data?.connected ?? []);
      const providers = (result.data?.all ?? []).filter((provider) => connected.has(provider.id));
      const defaults = result.data?.default ?? {};
      const discovered = providers.flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          providerId: provider.id,
          modelId: model.id,
          displayName: model.name,
          providerName: provider.name,
          ...(model.limit?.context === undefined ? {} : { contextLimit: model.limit.context }),
          inputModalities:
            model.modalities?.input ?? (model.attachment ? ["text", "image"] : ["text"]),
          variants: [],
          isDefault: defaults[provider.id] === model.id,
        })),
      );
      if (discovered.length > 0) return discovered;
      const config = (await client.config.get({ query: { directory } })).data;
      return Object.entries(config?.provider ?? {}).flatMap(([providerId, provider]) =>
        Object.entries(provider.models ?? {}).map(([modelId, model]) => ({
          providerId,
          modelId,
          displayName: model.name ?? modelId,
          providerName: provider.name ?? providerId,
          contextLimit: model.limit?.context,
          inputModalities:
            model.modalities?.input ?? (model.attachment ? ["text", "image"] : ["text"]),
          variants: [],
          isDefault: config?.model === `${providerId}/${modelId}`,
        })),
      );
    },
    async serializedContext(sessionId) {
      const messages = await client.session.messages({
        path: { id: sessionId },
        query: { directory },
      });
      return JSON.stringify(messages.data ?? []);
    },
    async addMcp(name, url) {
      await client.mcp.add({
        body: { name, config: { type: "remote", url, enabled: true } },
        query: { directory },
      });
    },
    async prompt({ sessionId, text, files, model, onEvent, signal }) {
      if (model?.variant !== undefined) {
        throw new Error("OpenCode 1.x SDK does not support model variants.");
      }
      const controller = new AbortController();
      const subscription = await client.event.subscribe({
        query: { directory },
        signal: controller.signal,
      });
      let settled = false;
      let settle!: () => void;
      let fail!: (reason: unknown) => void;
      const terminal = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      void terminal.catch(() => undefined);
      const reader = (async () => {
        try {
          for await (const event of subscription.stream) {
            if (signal.aborted || settled) break;
            const data = asRecord(event);
            if (data === undefined) continue;
            const type = string(data["type"]);
            const properties = asRecord(data["properties"]) ?? {};
            const eventSession =
              string(properties["sessionID"]) ??
              string(asRecord(properties["part"])?.["sessionID"]);
            if (eventSession !== sessionId) continue;
            await onEvent({ type: type ?? "unknown", data: properties });
            if (type === "session.error") {
              settled = true;
              fail(
                new Error(
                  `OpenCode session failed: ${JSON.stringify(properties["error"] ?? properties)}`,
                ),
              );
            } else if (type === "session.idle") {
              settled = true;
              settle();
            }
          }
          if (!settled && !controller.signal.aborted)
            fail(new Error("OpenCode event stream ended before the turn completed."));
        } catch (error) {
          if (!settled && !controller.signal.aborted) fail(error);
        }
      })();
      try {
        await client.session.promptAsync({
          path: { id: sessionId },
          query: { directory },
          body: {
            parts: [
              { type: "text", text },
              ...files.map((file) => ({
                type: "file" as const,
                mime: file.mimeType,
                filename: file.name,
                url: file.uri,
              })),
            ],
            ...(model === undefined
              ? {}
              : { model: { providerID: model.providerId, modelID: model.modelId } }),
            ...(systemPrompt === "" ? {} : { system: systemPrompt }),
          },
        });
        await Promise.race([terminal, abortPromise(signal)]);
        const messages = await client.session.messages({
          path: { id: sessionId },
          query: { directory },
        });
        const last = [...(messages.data ?? [])]
          .reverse()
          .find((message) => message.info.role === "assistant");
        if (last?.info.role !== "assistant")
          throw new Error("OpenCode turn ended without an assistant message.");
        if (last.info.error !== undefined)
          throw new Error(`OpenCode turn failed: ${last.info.error.name}.`);
        const content = last.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        return { text: content, usage: readUsage(last.info.tokens, content !== "") };
      } finally {
        settled = true;
        controller.abort();
        await reader.catch(() => undefined);
      }
    },
    async cancel(sessionId) {
      await client.session.abort({ path: { id: sessionId }, query: { directory } });
    },
    async compact(sessionId, model) {
      if (model === undefined)
        throw new Error("OpenCode 1.x compaction requires a selected model.");
      await client.session.summarize({
        path: { id: sessionId },
        query: { directory },
        body: { providerID: model.providerId, modelID: model.modelId },
      });
    },
    async replyPermission(sessionId, requestId, approved) {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: requestId },
        query: { directory },
        body: { response: approved ? "once" : "reject" },
      });
    },
    async replyQuestion(_sessionId, requestId, answers) {
      await replyV1Question(process, directory, requestId, answers);
    },
    async close() {
      await process.close();
    },
  };
}

function connectV2(process: OpenCodeProcess, directory: string): OpenCodeClient {
  const client = OpenCode.make({ baseUrl: process.url, headers: { ...process.headers } });
  const location = { directory };
  return {
    async createSession(restoredId, systemPrompt, permissions) {
      if (restoredId !== "") {
        const restored = await client.session.get({ sessionID: restoredId });
        if (
          restored.id !== restoredId ||
          !(await sameDirectory(restored.location.directory, directory))
        ) {
          throw new Error("OpenCode session restore has a different ID or workspace.");
        }
        await client.session.update({ sessionID: restoredId, permissions: [...permissions] });
        if (systemPrompt !== "") {
          await client.session.instructions.entry.put({
            sessionID: restoredId,
            key: "pragma.system",
            value: systemPrompt,
          });
        } else {
          await client.session.instructions.entry.remove({
            sessionID: restoredId,
            key: "pragma.system",
          });
        }
        return restoredId;
      }
      const created = await client.session.create({ location, permissions: [...permissions] });
      if (systemPrompt !== "") {
        await client.session.instructions.entry.put({
          sessionID: created.id,
          key: "pragma.system",
          value: systemPrompt,
        });
      }
      return created.id;
    },
    async listModels() {
      const [models, defaultModel] = await Promise.all([
        client.model.list({ location }),
        client.model.default({ location }),
      ]);
      const discovered = models.data.map((model) => ({
        providerId: model.providerID,
        modelId: model.id,
        displayName: model.name,
        providerName: model.providerID,
        ...(model.limit?.context === undefined ? {} : { contextLimit: model.limit.context }),
        inputModalities: model.capabilities.input,
        variants: model.variants.map((variant) => variant.id),
        isDefault:
          defaultModel.data?.providerID === model.providerID && defaultModel.data.id === model.id,
      }));
      if (discovered.length > 0) return discovered;
      const config = await client.config.get({ location });
      const configured = new Map<string, OpenCodeModel>();
      for (const entry of config) {
        if (entry.type !== "document") continue;
        for (const [providerId, provider] of Object.entries(entry.info.providers ?? {})) {
          for (const [modelId, model] of Object.entries(provider.models ?? {})) {
            if (model.disabled) continue;
            configured.set(`${providerId}/${modelId}`, {
              providerId,
              modelId,
              displayName: model.name ?? modelId,
              providerName: provider.name ?? providerId,
              contextLimit: model.limit?.context,
              inputModalities: model.capabilities?.input,
              variants: model.variants?.map((variant) => variant.id),
              isDefault: entry.info.model === `${providerId}/${modelId}`,
            });
          }
        }
      }
      return [...configured.values()];
    },
    async serializedContext(sessionId) {
      return JSON.stringify(await client.session.context({ sessionID: sessionId }));
    },
    async addMcp(name, url) {
      await client.mcp.add({
        server: name,
        location,
        config: { type: "remote", url, oauth: false },
      });
    },
    async prompt({ sessionId, text, files, model, onEvent, signal }) {
      const controller = new AbortController();
      const reader = (async () => {
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          if (signal.aborted) break;
          const data = asRecord(event.data) ?? {};
          if ((data["sessionID"] ?? asRecord(data["form"])?.["sessionID"]) !== sessionId) continue;
          await onEvent({ type: event.type, data });
        }
        if (!controller.signal.aborted) {
          throw new Error("OpenCode event stream ended before the turn completed.");
        }
      })();
      const streamFailure = reader.then(() => {
        throw new Error("OpenCode event stream ended before the turn completed.");
      });
      void streamFailure.catch(() => undefined);
      try {
        if (model !== undefined) {
          await client.session.switchModel({
            sessionID: sessionId,
            model: {
              providerID: model.providerId,
              id: model.modelId,
              ...(model.variant === undefined ? {} : { variant: model.variant }),
            },
          });
        }
        await Promise.race([
          client.session.prompt({
            sessionID: sessionId,
            text,
            files: files.map((file) => ({ uri: file.uri, name: file.name })),
          }),
          streamFailure,
          abortPromise(signal),
        ]);
        await Promise.race([
          client.session.wait({ sessionID: sessionId }),
          streamFailure,
          abortPromise(signal),
        ]);
        const context = await client.session.context({ sessionID: sessionId });
        const last = [...context].reverse().find((message) => message.type === "assistant");
        if (last?.type !== "assistant")
          throw new Error("OpenCode turn ended without an assistant message.");
        if (last.error !== undefined)
          throw new Error(`OpenCode turn failed: ${last.error.message}.`);
        const outputText = last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        return { text: outputText, usage: readUsage(last.tokens, outputText !== "") };
      } finally {
        controller.abort();
        await reader.catch(() => undefined);
      }
    },
    async cancel(sessionId) {
      await client.session.interrupt({ sessionID: sessionId, resume: false });
    },
    async compact(sessionId) {
      await client.session.compact({ sessionID: sessionId });
      await client.session.wait({ sessionID: sessionId });
    },
    async replyPermission(sessionId, requestId, approved) {
      await client.permission.reply({
        sessionID: sessionId,
        requestID: requestId,
        decision: approved ? "once" : "reject",
      });
    },
    async replyQuestion(sessionId, requestId, answers) {
      if (requestId.startsWith("que_")) {
        await replyV1Question(process, directory, requestId, answers);
        return;
      }
      if (answers === undefined) {
        await client.session.form.cancel({ sessionID: sessionId, formID: requestId });
      } else if (!Array.isArray(answers)) {
        await client.session.form.reply({
          sessionID: sessionId,
          formID: requestId,
          answer: { ...(answers as Readonly<Record<string, string | readonly string[]>>) },
        });
      } else {
        throw new Error("OpenCode 2.x form requires keyed answers.");
      }
    },
    async close() {
      await process.close();
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function replyV1Question(
  process: OpenCodeProcess,
  directory: string,
  requestId: string,
  answers:
    | readonly (readonly string[])[]
    | Readonly<Record<string, string | readonly string[]>>
    | undefined,
): Promise<void> {
  const url = new URL(
    `/question/${encodeURIComponent(requestId)}/${answers === undefined ? "reject" : "reply"}`,
    process.url,
  );
  url.searchParams.set("directory", directory);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...process.headers, "content-type": "application/json" },
    ...(answers === undefined ? {} : { body: JSON.stringify({ answers }) }),
  });
  if (!response.ok) throw new Error(`OpenCode question response failed: HTTP ${response.status}.`);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function sameDirectory(first: string, second: string): Promise<boolean> {
  return (await realpath(first)) === (await realpath(second));
}

function readUsage(value: unknown, hasResponse: boolean): OpenCodeTurnOutput["usage"] {
  const tokens = asRecord(value);
  if (
    tokens === undefined ||
    typeof tokens["input"] !== "number" ||
    !Number.isFinite(tokens["input"]) ||
    tokens["input"] < 0 ||
    typeof tokens["output"] !== "number" ||
    !Number.isFinite(tokens["output"]) ||
    tokens["output"] < 0
  )
    return undefined;
  const cache = asRecord(tokens["cache"]);
  const usage = {
    input: numeric(tokens["input"]),
    output: numeric(tokens["output"]),
    cacheRead: numeric(cache?.["read"]),
    cacheWrite: numeric(cache?.["write"]),
  };
  return hasResponse && Object.values(usage).every((count) => count === 0) ? undefined : usage;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
