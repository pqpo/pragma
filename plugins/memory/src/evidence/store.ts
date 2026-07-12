import {
  errorMemory,
  okMemory,
  parseMemoryEvidenceRecord,
  type MemoryEvidenceRecord,
  type MemoryEvidenceStore,
} from "../memory-system/index.ts";
import { sameRuntimeSession } from "../memory-system/runtime-session.ts";
import { DISTILLATION_EVIDENCE_PREFIX, JSON_EXTENSION } from "../context-projection/constants.ts";
import { resolveConfig } from "../skill-memory/config.ts";
import {
  collectRecursiveIds,
  exists,
  readStoredContext,
  resolveContextPath,
  resolveMemoryContextRoot,
  writeJson,
} from "../context-projection/filesystem.ts";
import type { ExpertAgentPluginSetupContext } from "@pragma/core";

export function createFileSystemMemoryEvidenceStore(
  context: ExpertAgentPluginSetupContext,
): MemoryEvidenceStore {
  const agentId = context.agent?.id ?? "unknown-agent";

  return {
    async list(input) {
      const rootDir = await resolveRootDir();
      const ids = await collectRecursiveIds(rootDir, DISTILLATION_EVIDENCE_PREFIX, [
        JSON_EXTENSION,
      ]);
      const records = await Promise.all(
        ids.map(async (id) => parseEvidenceRecord(await readStoredContext(rootDir, id))),
      );

      return okMemory(
        records.filter((record) => {
          if (input.kind !== undefined && record.kind !== input.kind) {
            return false;
          }

          if (input.executionId !== undefined && record.executionId !== input.executionId) {
            return false;
          }

          if (input.invocationId !== undefined && record.invocationId !== input.invocationId) {
            return false;
          }

          if (
            input.runtimeSession !== undefined &&
            !sameRuntimeSession(record.runtimeSession, input.runtimeSession)
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
      const record = parseMemoryEvidenceRecord(input.record);
      const id = toContextId(record.id);
      await writeJson(
        resolveContextPath(rootDir, id),
        record as unknown as Record<string, unknown>,
      );
      return okMemory(record);
    },
  };

  async function resolveRootDir(): Promise<string> {
    const config = await resolveConfig(context);
    return resolveMemoryContextRoot(context.workspaceRoot, config, agentId);
  }
}

function toContextId(id: string): string {
  return `${DISTILLATION_EVIDENCE_PREFIX}${id}${JSON_EXTENSION}`;
}

function parseEvidenceRecord(
  stored: Awaited<ReturnType<typeof readStoredContext>>,
): MemoryEvidenceRecord {
  return parseMemoryEvidenceRecord(JSON.parse(stored.content) as unknown);
}
