import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import {
  PragmaResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import {
  StewardChangeSetSchema,
  StewardProjectCommitSchema,
  type StewardDslProjectPort,
} from "@pragma/steward";
import { z } from "zod";

import type { PragmaProjectStore } from "./pragma-project-store.ts";

const CandidateRecordSchema = z.object({
  changeSet: StewardChangeSetSchema,
  resources: z.array(PragmaResourceSchema),
});

export function createDesktopStewardProjectPort(options: {
  readonly project: PragmaProjectStore;
  readonly stateRoot: string;
}): StewardDslProjectPort {
  const candidatePath = (id: string) =>
    join(options.stateRoot, "change-sets", `${encodePragmaPathSegment(id)}.json`);
  const operationPath = (id: string) =>
    join(options.stateRoot, "operations", `${encodePragmaPathSegment(id)}.json`);

  return {
    async list() {
      const snapshot = await options.project.get();
      return {
        projectRevision: snapshot.revision,
        resources: snapshot.resources.map((resource) => ({
          ref: canonicalPragmaResourceRef(resource),
          kind: resource.kind,
          name: resource.metadata.name,
          description: resource.metadata.description,
          version: resource.metadata.version,
        })),
      };
    },
    async read(ref) {
      const snapshot = await options.project.get();
      const resource = snapshot.resources.find(
        (candidate) => canonicalPragmaResourceRef(candidate) === ref,
      );
      if (resource === undefined) throw new Error(`Pragma resource not found: ${ref}`);
      return {
        ref: canonicalPragmaResourceRef(resource),
        kind: resource.kind,
        name: resource.metadata.name,
        description: resource.metadata.description,
        version: resource.metadata.version,
        projectRevision: snapshot.revision,
        source: formatPragmaYaml(resource),
      };
    },
    async prepare(input) {
      const snapshot = await options.project.get();
      if (snapshot.revision !== input.expectedProjectRevision) {
        throw new Error(
          `Project revision changed from ${input.expectedProjectRevision} to ${snapshot.revision}.`,
        );
      }
      const resources = input.sources.map(parseStewardResource);
      const refs = resources.map(canonicalPragmaResourceRef);
      if (new Set(refs).size !== refs.length) throw new Error("A change-set cannot repeat a ref.");
      const diagnostics = await options.project.service.validateCandidate({
        projectId: options.project.projectId,
        expectedRevision: snapshot.revision,
        upserts: resources,
      });
      const existing = new Set(snapshot.resources.map(canonicalPragmaResourceRef));
      const changeSet = StewardChangeSetSchema.parse({
        changeSetId: randomUUID(),
        projectRevision: snapshot.revision,
        diagnostics,
        changes: resources.map((resource) => ({
          ref: canonicalPragmaResourceRef(resource),
          kind: existing.has(canonicalPragmaResourceRef(resource)) ? "updated" : "created",
          source: formatPragmaYaml(resource),
        })),
        createdAt: new Date().toISOString(),
      });
      await writeJson(candidatePath(changeSet.changeSetId), { changeSet, resources });
      return changeSet;
    },
    async getChangeSet(changeSetId) {
      return (await readCandidate(candidatePath(changeSetId))).changeSet;
    },
    async commit(input) {
      const path = operationPath(input.operationId);
      return await withFileLock(`${path}.lock`, async () => {
        const completed = await readJson(path);
        if (completed !== undefined) return StewardProjectCommitSchema.parse(completed);
        const candidate = await readCandidate(candidatePath(input.changeSetId));
        if (candidate.changeSet.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
          throw new Error("The prepared DSL change-set contains validation errors.");
        }
        const published = await options.project.service.apply({
          projectId: options.project.projectId,
          expectedRevision: candidate.changeSet.projectRevision,
          upserts: candidate.resources,
        });
        const result = StewardProjectCommitSchema.parse({
          projectId: published.projectId,
          projectRevision: published.revision,
          changedRefs: candidate.changeSet.changes.map((change) => change.ref),
        });
        await writeJson(path, result);
        return result;
      });
    },
  };
}

function parseStewardResource(source: string): PragmaResource {
  const resource = PragmaResourceSchema.parse(parsePragmaYaml(source));
  if (resource.kind !== "Expert" && resource.kind !== "ExpertTeam" && resource.kind !== "Flow") {
    throw new Error("Steward v1 can only create or update Expert, ExpertTeam, and Flow resources.");
  }
  return resource;
}

async function readCandidate(path: string): Promise<z.infer<typeof CandidateRecordSchema>> {
  const value = await readJson(path);
  if (value === undefined) throw new Error("Prepared DSL change-set not found.");
  return CandidateRecordSchema.parse(value);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
