import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  ExpertAgentHumanRequestSchema,
  ExpertAgentHumanResponseSchema,
  type ExpertAgentHumanInteractionHandler,
  type ExpertAgentHumanRequest,
  type ExpertAgentHumanResponse,
} from "../tools/managed-tool.ts";

const HumanInteractionScopeSchema = z.record(z.string(), z.string().min(1));

const HumanInteractionRecordBaseSchema = z.object({
  id: z.string().min(1),
  scope: HumanInteractionScopeSchema,
  request: ExpertAgentHumanRequestSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  attempts: z.number().int().nonnegative(),
});

export const PendingHumanInteractionSchema = HumanInteractionRecordBaseSchema.extend({
  status: z.literal("pending"),
});

export const ResolvedHumanInteractionSchema = HumanInteractionRecordBaseSchema.extend({
  status: z.literal("resolved"),
  response: ExpertAgentHumanResponseSchema,
  resolvedAt: z.string().datetime(),
});

export type HumanInteractionScope = z.infer<typeof HumanInteractionScopeSchema>;
export type PendingHumanInteraction = z.infer<typeof PendingHumanInteractionSchema>;
export type ResolvedHumanInteraction = z.infer<typeof ResolvedHumanInteractionSchema>;

export interface HumanInteractionStore {
  readonly savePending: (interaction: PendingHumanInteraction) => Promise<void> | void;
  readonly listPending: (
    scope: HumanInteractionScope,
  ) => Promise<readonly PendingHumanInteraction[]> | readonly PendingHumanInteraction[];
  readonly getPending: (
    scope: HumanInteractionScope,
  ) => Promise<PendingHumanInteraction | undefined> | PendingHumanInteraction | undefined;
  readonly resolve: (
    interactionId: string,
    response: ExpertAgentHumanResponse,
  ) => Promise<void> | void;
  readonly clear: (interactionId: string) => Promise<void> | void;
}

export interface CreateDurableHumanInteractionHandlerOptions {
  readonly scope: HumanInteractionScope;
  readonly store: HumanInteractionStore;
  readonly delegate: ExpertAgentHumanInteractionHandler;
  readonly createInteractionId?: ((request: ExpertAgentHumanRequest) => string) | undefined;
  readonly now?: (() => Date) | undefined;
}

export function createDurableHumanInteractionHandler(
  options: CreateDurableHumanInteractionHandlerOptions,
): ExpertAgentHumanInteractionHandler {
  return async (request) => {
    const pending = await upsertPendingHumanInteraction(options, request);

    const response = await options.delegate(request);
    await options.store.resolve(pending.id, response);

    return response;
  };
}

export interface CreateFileHumanInteractionStoreOptions {
  readonly rootDir: string;
  readonly now?: (() => Date) | undefined;
}

export function createFileHumanInteractionStore(
  options: CreateFileHumanInteractionStoreOptions,
): HumanInteractionStore {
  const pendingDir = join(options.rootDir, "pending");
  const resolvedDir = join(options.rootDir, "resolved");
  const listPending = async (
    scope: HumanInteractionScope,
  ): Promise<readonly PendingHumanInteraction[]> => {
    const pending = await readPendingInteractions(pendingDir);
    const resolvedIds = await readResolvedInteractionIds(resolvedDir);

    return pending
      .filter((interaction) => !resolvedIds.has(interaction.id))
      .filter((interaction) => scopeMatches(interaction.scope, scope))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  };
  const clear = async (interactionId: string): Promise<void> => {
    await rm(pendingPath(pendingDir, interactionId), { force: true });
  };

  return {
    async savePending(interaction) {
      await mkdir(pendingDir, { recursive: true });
      await writeJson(
        pendingPath(pendingDir, interaction.id),
        PendingHumanInteractionSchema.parse(interaction),
      );
    },
    listPending,
    async getPending(scope) {
      return (await listPending(scope))[0];
    },
    async resolve(interactionId, response) {
      const pending = await readPendingInteraction(pendingDir, interactionId);

      if (pending === undefined) {
        return;
      }

      const now = (options.now?.() ?? new Date()).toISOString();
      const resolved: ResolvedHumanInteraction = {
        ...pending,
        status: "resolved",
        response: ExpertAgentHumanResponseSchema.parse(response),
        resolvedAt: now,
        updatedAt: now,
      };

      await mkdir(resolvedDir, { recursive: true });
      await writeJson(pendingPath(resolvedDir, interactionId), resolved);
      await clear(interactionId);
    },
    clear,
  };
}

async function upsertPendingHumanInteraction(
  options: CreateDurableHumanInteractionHandlerOptions,
  request: ExpertAgentHumanRequest,
): Promise<PendingHumanInteraction> {
  const parsedRequest = ExpertAgentHumanRequestSchema.parse(request);
  const existing = (await options.store.listPending(options.scope)).find((interaction) =>
    sameHumanRequest(interaction.request, parsedRequest),
  );
  const now = (options.now?.() ?? new Date()).toISOString();
  const pending: PendingHumanInteraction =
    existing === undefined
      ? {
          id: options.createInteractionId?.(parsedRequest) ?? randomUUID(),
          scope: HumanInteractionScopeSchema.parse(options.scope),
          request: parsedRequest,
          status: "pending",
          createdAt: now,
          updatedAt: now,
          attempts: 1,
        }
      : {
          ...existing,
          request: parsedRequest,
          updatedAt: now,
          attempts: existing.attempts + 1,
        };

  await options.store.savePending(pending);

  return pending;
}

async function readPendingInteractions(dir: string): Promise<readonly PendingHumanInteraction[]> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  });

  return await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) =>
        PendingHumanInteractionSchema.parse(JSON.parse(await readFile(join(dir, entry), "utf8"))),
      ),
  );
}

async function readResolvedInteractionIds(dir: string): Promise<ReadonlySet<string>> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if (isNodeErrorCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  });

  const resolved = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) =>
        ResolvedHumanInteractionSchema.parse(JSON.parse(await readFile(join(dir, entry), "utf8"))),
      ),
  );

  return new Set(resolved.map((interaction) => interaction.id));
}

async function readPendingInteraction(
  dir: string,
  interactionId: string,
): Promise<PendingHumanInteraction | undefined> {
  const content = await readFile(pendingPath(dir, interactionId), "utf8").catch(
    (error: unknown) => {
      if (isNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }

      throw error;
    },
  );

  return content === undefined
    ? undefined
    : PendingHumanInteractionSchema.parse(JSON.parse(content));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pendingPath(dir: string, interactionId: string): string {
  return join(dir, `${encodeURIComponent(interactionId)}.json`);
}

function scopeMatches(candidate: HumanInteractionScope, expected: HumanInteractionScope): boolean {
  return Object.entries(expected).every(([key, value]) => candidate[key] === value);
}

function sameHumanRequest(left: ExpertAgentHumanRequest, right: ExpertAgentHumanRequest): boolean {
  return stableStringify(logicalHumanRequest(left)) === stableStringify(logicalHumanRequest(right));
}

function logicalHumanRequest(request: ExpertAgentHumanRequest): unknown {
  if (request.kind !== "tool_approval") {
    return request;
  }

  return {
    kind: request.kind,
    toolName: request.toolName,
    reason: request.reason,
    input: request.input,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}
