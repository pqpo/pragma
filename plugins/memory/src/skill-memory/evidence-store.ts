import {
  errorMemory,
  okMemory,
  type MemoryEvidenceRecord,
  type MemoryEvidenceStore,
} from "../memory-system/index.ts";
import { DISTILLATION_EVIDENCE_PREFIX, JSON_EXTENSION } from "./constants.ts";
import { resolveConfig } from "./config.ts";
import {
  collectRecursiveIds,
  exists,
  readStoredContext,
  resolveContextPath,
  resolveMemoryRoot,
  writeJson,
} from "./filesystem.ts";
import type { ExpertAgentPluginSetupContext } from "@pragma/core";

export function createFileSystemMemoryEvidenceStore(
  context: ExpertAgentPluginSetupContext,
): MemoryEvidenceStore {
  const agentId = context.agent?.id ?? "unknown-agent";

  return {
    async list(input) {
      const rootDir = await resolveRootDir();
      const ids = await collectRecursiveIds(rootDir, DISTILLATION_EVIDENCE_PREFIX, [JSON_EXTENSION]);
      const records = await Promise.all(
        ids.map(async (id) => parseEvidenceRecord(await readStoredContext(rootDir, id))),
      );

      return okMemory(
        records.filter((record) => {
          if (input.kind !== undefined && record.kind !== input.kind) {
            return false;
          }

          if (input.workflowRunId !== undefined && record.workflowRunId !== input.workflowRunId) {
            return false;
          }

          if (input.taskRunId !== undefined && record.taskRunId !== input.taskRunId) {
            return false;
          }

          if (
            input.runtimeSessionId !== undefined &&
            record.runtimeSessionId !== input.runtimeSessionId
          ) {
            return false;
          }

          return true;
        }),
      );
    },

    async get(input) {
      const rootDir = await resolveRootDir();
      const id = toContextId(input.id);

      if (!(await exists(resolveContextPath(rootDir, id)))) {
        return errorMemory("memory_not_found", `Memory evidence not found: ${input.id}`, {
          id: input.id,
        });
      }

      return okMemory(parseEvidenceRecord(await readStoredContext(rootDir, id)));
    },

    async write(input) {
      const rootDir = await resolveRootDir();
      const id = toContextId(input.record.id);
      await writeJson(resolveContextPath(rootDir, id), input.record as unknown as Record<string, unknown>);
      return okMemory(input.record);
    },
  };

  async function resolveRootDir(): Promise<string> {
    const config = await resolveConfig(context);
    return resolveMemoryRoot(context.workspaceRoot, config, agentId);
  }
}

function toContextId(id: string): string {
  return `${DISTILLATION_EVIDENCE_PREFIX}${id}${JSON_EXTENSION}`;
}

function parseEvidenceRecord(
  stored: Awaited<ReturnType<typeof readStoredContext>>,
): MemoryEvidenceRecord {
  return JSON.parse(stored.content) as MemoryEvidenceRecord;
}
