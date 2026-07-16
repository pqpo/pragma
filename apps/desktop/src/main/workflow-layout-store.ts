import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment } from "@pragma/core";

import {
  WorkflowLayoutSchema,
  type DeleteWorkflowLayout,
  type GetWorkflowLayout,
  type WorkflowLayout,
} from "../shared/desktop-api.ts";

export interface WorkflowLayoutStore {
  get(input: GetWorkflowLayout): Promise<WorkflowLayout | null>;
  save(layout: WorkflowLayout): Promise<WorkflowLayout>;
  remove(input: DeleteWorkflowLayout): Promise<void>;
}

export function createWorkflowLayoutStore(options: {
  readonly projectsPath: string;
}): WorkflowLayoutStore {
  const layoutPath = (input: GetWorkflowLayout) =>
    join(
      options.projectsPath,
      input.projectId,
      "layouts",
      "flows",
      `${encodePragmaPathSegment(input.flowId)}.json`,
    );

  return {
    async get(input) {
      try {
        return WorkflowLayoutSchema.parse(JSON.parse(await readFile(layoutPath(input), "utf8")));
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return null;
        if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
          return null;
        }
        throw error;
      }
    },
    async save(layout) {
      const parsed = WorkflowLayoutSchema.parse(layout);
      const path = layoutPath(parsed);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, path);
      return parsed;
    },
    async remove(input) {
      await rm(layoutPath(input), { force: true });
    },
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
