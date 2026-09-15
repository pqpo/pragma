import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "@pragma/core";
import { z } from "zod";
import {
  HomeProjectIdSchema,
  HomeProjectSchema,
  ReorderHomeProjectsSchema,
  SaveHomeProjectSchema,
  type HomeProject,
  type SaveHomeProject,
} from "../../../shared/contracts/home-projects.ts";

const HomeProjectFileSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-home-projects/v1"),
    projects: z
      .array(HomeProjectSchema)
      .max(1_000)
      .refine(
        (projects) => new Set(projects.map((project) => project.id)).size === projects.length,
      ),
  })
  .strict();

export function createHomeProjectStore(path: string) {
  const read = async (): Promise<z.infer<typeof HomeProjectFileSchema>> => {
    try {
      return HomeProjectFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { schemaVersion: "pragma.desktop-home-projects/v1", projects: [] };
      }
      throw error;
    }
  };
  const mutate = async (update: (projects: HomeProject[]) => HomeProject[]) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return withFileLock(`${path}.lock`, async () => {
      const current = await read();
      const next = HomeProjectFileSchema.parse({ ...current, projects: update(current.projects) });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return next.projects;
    });
  };
  return {
    async list() {
      return (await read()).projects;
    },
    async save(input: SaveHomeProject) {
      const parsed = SaveHomeProjectSchema.parse(input);
      const project = HomeProjectSchema.parse({ ...parsed, id: parsed.id ?? randomUUID() });
      await mutate((projects) => {
        if (parsed.id !== undefined && !projects.some((item) => item.id === parsed.id)) {
          throw new Error("Home project no longer exists.");
        }
        return parsed.id === undefined
          ? [...projects, project]
          : projects.map((item) => (item.id === project.id ? project : item));
      });
      return project;
    },
    async reorder(ids: readonly string[]) {
      const orderedIds = ReorderHomeProjectsSchema.parse(ids);
      return mutate((projects) => {
        if (
          orderedIds.length !== projects.length ||
          projects.some((project) => !orderedIds.includes(project.id))
        ) {
          throw new Error("Home project order must include every current project exactly once.");
        }
        const projectsById = new Map(projects.map((project) => [project.id, project]));
        return orderedIds.map((id) => projectsById.get(id)!);
      });
    },
    async delete(id: string) {
      const parsed = HomeProjectIdSchema.parse(id);
      await mutate((projects) => projects.filter((item) => item.id !== parsed));
    },
  };
}
export type HomeProjectStore = ReturnType<typeof createHomeProjectStore>;
