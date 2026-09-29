import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";

import {
  WorkflowLayoutSchema,
  type DeleteWorkflowLayout,
  type GetWorkflowLayout,
  type WorkflowLayout,
} from "../../../shared/contracts/index.ts";

const RemovalJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-flow-layout-removal/v1"),
    projectId: z.string().min(1),
    flowId: z.string().min(1),
    targetProjectRevision: z.number().int().positive(),
  })
  .strict();

export type WorkflowLayoutVersion = Pick<WorkflowLayout, "nodes" | "viewport"> | null;

export interface WorkflowLayoutStore {
  prepareRemoval(input: GetWorkflowLayout, baseRevision: number): Promise<void>;
  recoverRemovals(
    projectId: string,
    getProject: () => Promise<{ revision: number; flowIds: readonly string[] }>,
  ): Promise<void>;
  get(input: GetWorkflowLayout): Promise<WorkflowLayout | null>;
  save(layout: WorkflowLayout, expected?: WorkflowLayoutVersion): Promise<WorkflowLayout>;
  remove(input: DeleteWorkflowLayout, expected?: WorkflowLayoutVersion): Promise<void>;
}

export function createWorkflowLayoutStore(options: {
  readonly projectsPath: string;
  readonly onChanged?: (() => void) | undefined;
}): WorkflowLayoutStore {
  const layoutPath = (input: GetWorkflowLayout) =>
    join(
      options.projectsPath,
      input.projectId,
      "layouts",
      "flows",
      `${encodePragmaPathSegment(input.flowId)}.json`,
    );

  const get = async (input: GetWorkflowLayout): Promise<WorkflowLayout | null> => {
    try {
      return WorkflowLayoutSchema.parse(JSON.parse(await readFile(layoutPath(input), "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
        return null;
      }
      throw error;
    }
  };
  const checkExpected = async (
    input: GetWorkflowLayout,
    expected: WorkflowLayoutVersion | undefined,
  ) => {
    if (expected === undefined) return;
    const current = await get(input);
    if (
      !isDeepStrictEqual(
        current === null ? null : { nodes: current.nodes, viewport: current.viewport },
        expected,
      )
    )
      throw new Error("asset_sync.restore_conflict: Flow layout changed during restore.");
  };
  return {
    get,
    async prepareRemoval(input, baseRevision) {
      const directory = join(options.projectsPath, input.projectId, "layouts", ".removals");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(
        directory,
        `${encodePragmaPathSegment(input.flowId)}-${baseRevision + 1}.json`,
      );
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify(
          RemovalJournalSchema.parse({
            schemaVersion: "pragma.desktop-flow-layout-removal/v1",
            projectId: input.projectId,
            flowId: input.flowId,
            targetProjectRevision: baseRevision + 1,
          }),
        ),
        { mode: 0o600 },
      );
      await rename(temporary, path);
    },
    async recoverRemovals(projectId, getProject) {
      const directory = join(options.projectsPath, projectId, "layouts", ".removals");
      const entries = await readdir(directory).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      });
      for (const entry of entries.filter((name) => name.endsWith(".json"))) {
        const journalPath = join(directory, entry);
        let journal;
        try {
          journal = RemovalJournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
        } catch (error) {
          if (isNodeError(error, "ENOENT")) continue;
          throw error;
        }
        if (journal.projectId !== projectId)
          throw new Error("Flow layout removal belongs to another Project.");
        const path = layoutPath(journal);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await withFileLock(`${path}.lock`, async () => {
          const current = await getProject();
          if (current.revision < journal.targetProjectRevision) return;
          // A successful CAS removed the Flow, or another publication invalidated
          // the deletion intent. Retain layouts of Flows that still exist.
          if (!current.flowIds.includes(journal.flowId)) await rm(path, { force: true });
          await rm(journalPath, { force: true });
        });
      }
    },

    async save(layout, expected) {
      const parsed = WorkflowLayoutSchema.parse(layout);
      const path = layoutPath(parsed);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      return await withFileLock(`${path}.lock`, async () => {
        await checkExpected(parsed, expected);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, path);
        options.onChanged?.();
        return parsed;
      });
    },
    async remove(input, expected) {
      const path = layoutPath(input);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await withFileLock(`${path}.lock`, async () => {
        await checkExpected(input, expected);
        await rm(path, { force: true });
        options.onChanged?.();
      });
    },
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
