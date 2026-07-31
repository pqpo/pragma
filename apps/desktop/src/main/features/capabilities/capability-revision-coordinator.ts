import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import {
  canonicalPragmaResourceRef,
  type PragmaCapabilityResource,
  type PragmaExpertResource,
} from "@pragma/interpreter/ast";
import { z } from "zod";

import {
  bindExistingDesktopCapabilityResource,
  classifyDesktopCapabilityResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import {
  PragmaProjectStoreError,
  type PragmaProjectStore,
} from "../projects/pragma-project-store.ts";
import {
  CapabilityStoreError,
  type CapabilityRevisionPublisher,
  type CapabilityStore,
} from "./capability-store.ts";
import type { Capability } from "../../../shared/contracts/index.ts";
import { CapabilityHealthSchema } from "../../../shared/contracts/index.ts";

const JournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.capability-revision-propagation/v1"),
    capabilityId: z.string().uuid(),
    targetRevision: z.number().int().positive(),
    stage: z.enum([
      "revision-pending",
      "revision-written",
      "project-propagated",
      "system-experts-propagated",
    ]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    projectRevision: z.number().int().positive().optional(),
    previousHealth: CapabilityHealthSchema,
  })
  .strict();

type Journal = z.infer<typeof JournalSchema>;

export interface CapabilityRevisionCoordinator extends CapabilityRevisionPublisher {
  recover(): Promise<void>;
}

export function createCapabilityRevisionCoordinator(options: {
  readonly journalRoot: string;
  readonly capabilities: CapabilityStore;
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): CapabilityRevisionCoordinator {
  const capabilityDirectory = (id: string) =>
    join(options.journalRoot, encodePragmaPathSegment(id));
  const journalPath = (id: string, revision: number) =>
    join(capabilityDirectory(id), `${revision}.json`);
  const lockPath = (id: string) => join(capabilityDirectory(id), ".lock");

  const writeJournal = async (journal: Journal): Promise<void> => {
    const path = journalPath(journal.capabilityId, journal.targetRevision);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(JournalSchema.parse(journal), null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  };

  const advance = async (
    journal: Journal,
    stage: Journal["stage"],
    extra: Partial<Pick<Journal, "projectRevision">> = {},
  ): Promise<Journal> => {
    const next = JournalSchema.parse({
      ...journal,
      ...extra,
      stage,
      updatedAt: new Date().toISOString(),
    });
    await writeJournal(next);
    return next;
  };

  const propagateProject = async (candidate: Capability): Promise<number | undefined> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const snapshot = await options.project.get();
      const upserts = snapshot.resources.flatMap((resource): PragmaCapabilityResource[] => {
        const binding = classifyDesktopCapabilityResource(resource);
        if (
          resource.kind !== "Capability" ||
          binding?.id !== candidate.manifest.id ||
          binding.revision === candidate.manifest.latestRevision
        ) {
          return [];
        }
        return [
          bindExistingDesktopCapabilityResource(
            resource,
            {
              id: candidate.manifest.id,
              revision: candidate.manifest.latestRevision,
            },
            resource.metadata.tags.includes("default-agent-option")
              ? {
                  name: candidate.definition.name,
                  description: capabilityDescription(candidate),
                }
              : undefined,
          ),
        ];
      });
      if (upserts.length === 0) return undefined;
      try {
        return (
          await options.project.apply({
            baseRevision: snapshot.revision,
            upserts,
          })
        ).revision;
      } catch (error) {
        if (
          attempt < 4 &&
          error instanceof PragmaProjectStoreError &&
          error.code === "revision_conflict"
        ) {
          continue;
        }
        throw error;
      }
    }
    return undefined;
  };

  const finishJournal = async (journal: Journal, candidate: Capability): Promise<void> => {
    let current = journal;
    if (current.stage === "revision-pending") {
      current = await advance(current, "revision-written");
    }
    if (current.stage === "revision-written") {
      const projectRevision = await propagateProject(candidate);
      current = await advance(current, "project-propagated", {
        ...(projectRevision === undefined ? {} : { projectRevision }),
      });
    }
    if (current.stage === "project-propagated") {
      await options.systemExperts.upgradeCapabilityRevision(
        candidate.manifest.id,
        candidate.manifest.latestRevision,
      );
      current = await advance(current, "system-experts-propagated");
    }
    if (current.stage === "system-experts-propagated") {
      await rm(journalPath(current.capabilityId, current.targetRevision), { force: true });
    }
  };

  const recoverCapabilityLocked = async (id: string): Promise<void> => {
    let entries: string[];
    try {
      entries = (await readdir(capabilityDirectory(id)))
        .filter((entry) => /^\d+\.json$/.test(entry))
        .toSorted((left, right) => Number(left.slice(0, -5)) - Number(right.slice(0, -5)));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(capabilityDirectory(id), entry);
      const journal = JournalSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
      const latest = await options.capabilities.get(id);
      if (
        journal.stage === "revision-pending" &&
        latest.manifest.latestRevision < journal.targetRevision
      ) {
        await options.capabilities.discardUnpublishedRevision(
          id,
          journal.targetRevision,
          journal.previousHealth,
        );
        await rm(path, { force: true });
        continue;
      }
      let candidate: Capability;
      try {
        candidate = await options.capabilities.get(id, journal.targetRevision);
      } catch (error) {
        if (
          journal.stage === "revision-pending" &&
          error instanceof CapabilityStoreError &&
          error.code === "capability_not_found"
        ) {
          await rm(path, { force: true });
          continue;
        }
        throw error;
      }
      if (candidate.health.status !== "ready") continue;
      if (journal.stage === "revision-pending" || journal.stage === "revision-written") {
        await assertCompatible(candidate);
      }
      await finishJournal(journal, candidate);
    }
  };

  const assertCompatible = async (candidate: Capability): Promise<void> => {
    const availableTools = new Set(capabilityToolNames(candidate));
    if (candidate.definition.kind === "skill") return;
    const incompatible: string[] = [];
    const snapshot = await options.project.get();
    const boundRefs = new Set(
      snapshot.resources.flatMap((resource) => {
        const binding = classifyDesktopCapabilityResource(resource);
        return binding?.id === candidate.manifest.id ? [canonicalPragmaResourceRef(resource)] : [];
      }),
    );
    for (const expert of snapshot.resources.filter(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    )) {
      for (const reference of expert.spec.capabilities) {
        if (reference.kind !== "tools" || !boundRefs.has(reference.ref)) continue;
        const missing = (reference.tools ?? []).filter((tool) => !availableTools.has(tool));
        if (missing.length > 0) {
          incompatible.push(`${canonicalPragmaResourceRef(expert)}: ${missing.join(", ")}`);
        }
      }
    }
    for (const summary of options.systemExperts.list()) {
      const expert = options.systemExperts.get(summary.ref);
      for (const reference of expert?.capabilities ?? []) {
        if (reference.capabilityId !== candidate.manifest.id || reference.kind !== "tools") {
          continue;
        }
        const missing = reference.toolNames.filter((tool) => !availableTools.has(tool));
        if (missing.length > 0) incompatible.push(`${summary.ref}: ${missing.join(", ")}`);
      }
    }
    if (incompatible.length > 0) {
      throw new CapabilityStoreError(
        "capability_incompatible",
        `Capability update removes tools selected by current Experts: ${incompatible.join("; ")}. Update those Experts first.`,
      );
    }
  };

  const cleanupCapabilityDirectory = async (id: string): Promise<void> => {
    try {
      await rmdir(capabilityDirectory(id));
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTEMPTY")) return;
      options.warn?.("An empty Capability revision journal directory could not be removed.", error);
    }
  };

  return {
    async publish(input) {
      const id = input.candidate.manifest.id;
      try {
        return await withFileLock(lockPath(id), async () => {
          await recoverCapabilityLocked(id);
          if (input.candidate.health.status !== "ready") return await input.commit();
          await assertCompatible(input.candidate);
          const timestamp = new Date().toISOString();
          let journal = JournalSchema.parse({
            schemaVersion: "pragma.capability-revision-propagation/v1",
            capabilityId: id,
            targetRevision: input.candidate.manifest.latestRevision,
            stage: "revision-pending",
            createdAt: timestamp,
            updatedAt: timestamp,
            previousHealth: input.current.health,
          });
          await writeJournal(journal);
          const committed = await input.commit();
          journal = await advance(journal, "revision-written");
          await finishJournal(journal, committed);
          return committed;
        });
      } finally {
        await cleanupCapabilityDirectory(id);
      }
    },
    async recover() {
      let directories;
      try {
        directories = await readdir(options.journalRoot, { withFileTypes: true });
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return;
        throw error;
      }
      for (const directory of directories.filter((entry) => entry.isDirectory())) {
        try {
          const firstJournal = (await readdir(join(options.journalRoot, directory.name))).find(
            (entry) => /^\d+\.json$/.test(entry),
          );
          if (firstJournal === undefined) {
            await rmdir(join(options.journalRoot, directory.name)).catch(() => undefined);
            continue;
          }
          const journal = JournalSchema.parse(
            JSON.parse(
              await readFile(join(options.journalRoot, directory.name, firstJournal), "utf8"),
            ) as unknown,
          );
          await withFileLock(lockPath(journal.capabilityId), async () => {
            await recoverCapabilityLocked(journal.capabilityId);
          });
          await cleanupCapabilityDirectory(journal.capabilityId);
        } catch (error) {
          options.warn?.("Capability revision propagation could not be recovered.", error);
        }
      }
    },
  };
}

function capabilityToolNames(capability: Capability): string[] {
  switch (capability.definition.kind) {
    case "skill":
      return [];
    case "code_service":
      return [capability.definition.tool.name];
    case "mcp_server":
    case "http_service":
      return capability.definition.tools.map((tool) => tool.name);
  }
}

function capabilityDescription(capability: Capability): string {
  const description = capability.definition.description.trim();
  return description === ""
    ? `Host-provided Desktop capability ${capability.definition.name}.`
    : description;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
