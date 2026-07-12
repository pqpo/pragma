import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import {
  HumanInteractionRecordSchema,
  TaskRunRecordSchema,
  WorkflowRunRecordSchema,
} from "@pragma/shared";
import { z } from "zod";

import { PragmaPaths } from "../storage/pragma-paths.ts";
import { withFileLock } from "../storage/file-lock.ts";
import {
  createInMemoryStateManagerBackend,
  type InMemoryStateManagerBackend,
  type WorkflowStateSnapshot,
} from "./in-memory-state-manager.ts";
import type { StateManager } from "./types.ts";

const WorkflowStateSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  workflow: WorkflowRunRecordSchema,
  tasks: z.array(TaskRunRecordSchema),
  humanInteractions: z.array(HumanInteractionRecordSchema),
  appliedMessageIds: z.array(z.string().min(1)),
});

const PersistedWorkflowStateSnapshotSchema = WorkflowStateSnapshotSchema.extend({
  workflow: WorkflowRunRecordSchema.extend({
    execution: WorkflowRunRecordSchema.shape.execution.optional(),
  }),
  tasks: z.array(
    TaskRunRecordSchema.extend({
      transitionApplied: TaskRunRecordSchema.shape.transitionApplied.optional(),
    }),
  ),
}).transform((snapshot) =>
  WorkflowStateSnapshotSchema.parse({
    ...snapshot,
    workflow: {
      ...snapshot.workflow,
      execution: snapshot.workflow.execution ?? {},
    },
    tasks: snapshot.tasks.map((task) => ({
      ...task,
      transitionApplied: task.transitionApplied ?? task.status === "succeeded",
    })),
  }),
);

export interface FileStateManagerOptions {
  readonly pragmaHome?: string | undefined;
  readonly paths?: PragmaPaths | undefined;
}

export function createFileStateManager(options: FileStateManagerOptions = {}): StateManager {
  const paths = options.paths ?? new PragmaPaths({ pragmaHome: options.pragmaHome });
  const loadBackend = async () => createInMemoryStateManagerBackend(await loadSnapshots(paths));

  const persist = async (
    backend: InMemoryStateManagerBackend,
    workflowRunIds: readonly string[],
  ) => {
    for (const workflowRunId of new Set(workflowRunIds)) {
      const snapshot = backend.snapshot(workflowRunId);
      if (snapshot !== undefined) {
        await writeSnapshot(paths, snapshot);
      }
    }
  };

  return new Proxy({} as StateManager, {
    get(_target, property) {
      return async (...args: unknown[]) => {
        const invoke = async () => {
          const backend = await loadBackend();
          const method = backend.manager[property as keyof StateManager] as (
            ...values: unknown[]
          ) => Promise<unknown>;
          const result = await method(...args);
          if (isMutation(property)) {
            await persist(
              backend,
              await resolveAffectedWorkflowIds(backend.manager, args, result),
            );
          }
          return result;
        };
        return isMutation(property)
          ? await withFileLock(paths.workflowStateLock(), invoke)
          : await invoke();
      };
    },
  });
}

async function loadSnapshots(paths: PragmaPaths): Promise<readonly WorkflowStateSnapshot[]> {
  let entries;
  try {
    entries = await readdir(paths.workflowsRoot(), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const snapshots: WorkflowStateSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const file = `${paths.workflowsRoot()}/${entry.name}/workflow.json`;
    try {
      snapshots.push(
        PersistedWorkflowStateSnapshotSchema.parse(JSON.parse(await readFile(file, "utf8"))),
      );
    } catch (error) {
      if (!isNotFound(error)) {
        throw new Error(`Invalid persisted Workflow state: ${file}`, { cause: error });
      }
    }
  }
  return snapshots;
}

async function writeSnapshot(paths: PragmaPaths, snapshot: WorkflowStateSnapshot): Promise<void> {
  const file = paths.workflowState(snapshot.workflow.id);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

const readMethods = new Set([
  "getWorkflowRun",
  "listWorkflowRuns",
  "getTaskRun",
  "listTaskRuns",
  "getHumanInteraction",
  "listHumanInteractions",
  "listReadyTransitions",
]);

function isMutation(property: string | symbol): boolean {
  return typeof property === "string" && !readMethods.has(property);
}

async function resolveAffectedWorkflowIds(
  manager: StateManager,
  args: readonly unknown[],
  result: unknown,
): Promise<readonly string[]> {
  if (isWorkflowRecord(result)) return [result.id];
  if (isTaskRecord(result)) return [result.workflowRunId];
  if (isInteractionRecord(result)) return [result.workflowRunId];
  if (isInteractionResult(result)) return [result.interaction.workflowRunId];
  if (isTransitionResult(result)) return [result.workflow.id];
  if (Array.isArray(result) && result.every(isTaskRecord)) {
    return result.map((task) => task.workflowRunId);
  }
  const first = args[0];
  if (typeof first === "object" && first !== null && "workflowRunId" in first) {
    return [String((first as { workflowRunId: unknown }).workflowRunId)];
  }
  if (typeof first === "string") {
    const task = await manager.getTaskRun(first);
    if (task !== undefined) return [task.workflowRunId];
    const interaction = await manager.getHumanInteraction(first);
    if (interaction !== undefined) return [interaction.workflowRunId];
    return [first];
  }
  return [];
}

function isWorkflowRecord(value: unknown): value is z.infer<typeof WorkflowRunRecordSchema> {
  return WorkflowRunRecordSchema.safeParse(value).success;
}
function isTaskRecord(value: unknown): value is z.infer<typeof TaskRunRecordSchema> {
  return TaskRunRecordSchema.safeParse(value).success;
}
function isInteractionRecord(
  value: unknown,
): value is z.infer<typeof HumanInteractionRecordSchema> {
  return HumanInteractionRecordSchema.safeParse(value).success;
}
function isTransitionResult(
  value: unknown,
): value is { workflow: z.infer<typeof WorkflowRunRecordSchema> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "workflow" in value &&
    isWorkflowRecord((value as { workflow: unknown }).workflow)
  );
}
function isInteractionResult(
  value: unknown,
): value is { interaction: z.infer<typeof HumanInteractionRecordSchema> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "interaction" in value &&
    isInteractionRecord((value as { interaction: unknown }).interaction)
  );
}
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
