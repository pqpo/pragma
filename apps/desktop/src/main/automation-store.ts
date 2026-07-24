import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";
import { z } from "zod";

import {
  AutomationBindingSchema,
  AutomationRunRecordSchema,
  type AutomationBinding,
  type AutomationRunRecord,
} from "../shared/desktop-api.ts";

const QueuedAutomationEventSchema = z
  .object({
    eventId: z.string().min(1).max(500),
    scheduledFor: z.string().datetime(),
    missionId: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();

const AutomationStateSchema = z
  .object({
    schemaVersion: z.literal("pragma.automation-state/v1"),
    automationRef: z.string().min(1),
    generation: z.string().uuid(),
    nextRunAt: z.string().datetime().optional(),
    missionId: z.string().uuid().optional(),
    queue: z.array(QueuedAutomationEventSchema).max(1_000),
    runs: z.array(AutomationRunRecordSchema).max(100),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type QueuedAutomationEvent = z.infer<typeof QueuedAutomationEventSchema>;
export type AutomationState = z.infer<typeof AutomationStateSchema>;

export interface AutomationStore {
  getBinding(ref: string): Promise<AutomationBinding | undefined>;
  saveBinding(binding: AutomationBinding): Promise<AutomationBinding>;
  getState(ref: string, generation: string): Promise<AutomationState>;
  updateState(
    ref: string,
    generation: string,
    update: (state: AutomationState) => AutomationState,
  ): Promise<AutomationState>;
  remove(ref: string): Promise<void>;
}

export class AutomationGenerationChangedError extends Error {
  constructor(readonly automationRef: string) {
    super(`Automation binding generation changed: ${automationRef}.`);
    this.name = "AutomationGenerationChangedError";
  }
}

export function createAutomationStore(paths: PragmaPaths): AutomationStore {
  const readBinding = async (ref: string): Promise<AutomationBinding | undefined> =>
    await readOptional(paths.automationBinding(ref), AutomationBindingSchema);
  const readState = async (ref: string, generation: string): Promise<AutomationState> => {
    const existing = await readOptional(paths.automationState(ref), AutomationStateSchema);
    if (existing !== undefined && existing.generation === generation) return existing;
    return AutomationStateSchema.parse({
      schemaVersion: "pragma.automation-state/v1",
      automationRef: ref,
      generation,
      queue: [],
      runs: [],
      updatedAt: new Date().toISOString(),
    });
  };
  return {
    getBinding: readBinding,
    async saveBinding(binding) {
      const parsed = AutomationBindingSchema.parse(binding);
      await writeJsonAtomic(paths.automationBinding(parsed.automationRef), parsed);
      return parsed;
    },
    async getState(ref, generation) {
      return await withFileLock(
        paths.automationLock(ref),
        async () => await readState(ref, generation),
      );
    },
    async updateState(ref, generation, update) {
      return await withFileLock(paths.automationLock(ref), async () => {
        const binding = await readBinding(ref);
        if (binding?.generation !== generation) {
          throw new AutomationGenerationChangedError(ref);
        }
        const current = await readState(ref, generation);
        const next = AutomationStateSchema.parse({
          ...update(current),
          schemaVersion: "pragma.automation-state/v1",
          automationRef: ref,
          generation,
          updatedAt: new Date().toISOString(),
        });
        await writeJsonAtomic(paths.automationState(ref), next);
        return next;
      });
    },
    async remove(ref) {
      await Promise.all([
        rm(paths.automationBinding(ref), { force: true }),
        rm(paths.automationStateRoot(ref), { recursive: true, force: true }),
      ]);
    },
  };
}

export function createAutomationBinding(input: {
  readonly automationRef: string;
  readonly previous?: AutomationBinding | undefined;
  readonly rotateGeneration: boolean;
  readonly workspace: AutomationBinding["workspace"];
  readonly toolPermissionMode: AutomationBinding["toolPermissionMode"];
  readonly modelOverride?: AutomationBinding["modelOverride"] | undefined;
}): AutomationBinding {
  const now = new Date().toISOString();
  return AutomationBindingSchema.parse({
    schemaVersion: "pragma.automation-binding/v1",
    automationRef: input.automationRef,
    revision: (input.previous?.revision ?? 0) + 1,
    generation:
      input.previous === undefined || input.rotateGeneration
        ? randomUUID()
        : input.previous.generation,
    workspace: input.workspace,
    placement: "desktop",
    toolPermissionMode: input.toolPermissionMode,
    ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
    createdAt: input.previous?.createdAt ?? now,
    updatedAt: now,
  });
}

export function appendAutomationRun(
  state: AutomationState,
  run: AutomationRunRecord,
): AutomationState {
  return { ...state, runs: [...state.runs, run].slice(-100) };
}

async function readOptional<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
