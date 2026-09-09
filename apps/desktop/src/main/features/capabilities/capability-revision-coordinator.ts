import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import {
  canonicalPragmaResourceRef,
  type PragmaCapabilityResource,
  type PragmaExpertResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
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
  type CapabilityMutationService,
  type CapabilityRepository,
} from "./capability-store.ts";
import type { Capability } from "../../../shared/contracts/index.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import {
  CapabilityMutationJournalSchema as JournalSchema,
  migrateCapabilityMutationJournal,
  type CapabilityMutationJournal as Journal,
} from "./capability-mutation-journal.ts";

export interface CapabilityRevisionCoordinator extends CapabilityMutationService {
  recover(): Promise<void>;
}

export function createCapabilityRevisionCoordinator(options: {
  readonly journalRoot: string;
  readonly capabilities: CapabilityRepository;
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly credentials: CapabilityCredentialStore;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): CapabilityRevisionCoordinator {
  const capabilityDirectory = (id: string) =>
    join(options.journalRoot, encodePragmaPathSegment(id));
  const journalPath = (id: string, revision: number) =>
    join(capabilityDirectory(id), `${revision}.json`);
  const lockPath = (id: string) => join(options.journalRoot, `${encodePragmaPathSegment(id)}.lock`);
  const prepareLockRoot = async (): Promise<void> => {
    await mkdir(options.journalRoot, { recursive: true, mode: 0o700 });
  };

  const writeJournal = async (journal: Journal): Promise<void> => {
    const path = journalPath(journal.capabilityId, journal.targetRevision);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(JournalSchema.parse(journal), null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  };

  const readJournal = async (path: string): Promise<Journal> => {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    const current = JournalSchema.safeParse(raw);
    if (current.success) return current.data;
    const migrated = migrateCapabilityMutationJournal(raw);
    await writeJournal(migrated);
    return migrated;
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
      assertProjectCompatible(candidate, snapshot.resources);
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
      const byRef = new Map(
        snapshot.resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
      );
      for (const resource of upserts) {
        byRef.set(canonicalPragmaResourceRef(resource), resource);
      }
      try {
        return (
          await options.project.publish({
            expectedRevision: snapshot.revision,
            resources: [...byRef.values()],
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
      const prepared =
        current.credentialMutation ?? (await options.credentials.pending(current.capabilityId));
      if (prepared !== undefined) {
        if (current.credentialMutation === undefined) {
          current = JournalSchema.parse({ ...current, credentialMutation: prepared });
          await writeJournal(current);
        }
        await options.credentials.activate(prepared);
      }
      current = await advance(current, "revision-written");
    }
    if (current.stage === "revision-written" && current.propagate) {
      const projectRevision = await propagateProject(candidate);
      current = await advance(current, "project-propagated", {
        ...(projectRevision === undefined ? {} : { projectRevision }),
      });
    }
    if (current.stage === "revision-written" && !current.propagate) {
      current = await advance(current, "system-experts-propagated");
    }
    if (current.stage === "project-propagated") {
      try {
        await options.systemExperts.validateAndUpgradeCapabilityRevision(
          candidate.manifest.id,
          candidate.manifest.latestRevision,
          capabilityToolNames(candidate),
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "capability_incompatible") {
          current = JournalSchema.parse({
            ...current,
            errorCode: "capability_incompatible",
            retryable: false,
            updatedAt: new Date().toISOString(),
          });
          await writeJournal(current);
          throw new CapabilityStoreError("capability_incompatible", error.message);
        }
        throw error;
      }
      current = await advance(current, "system-experts-propagated");
    }
    if (current.stage === "system-experts-propagated") {
      if (current.credentialMutation !== undefined) {
        await options.credentials.finalize(current.credentialMutation);
      }
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
      const journal = await readJournal(path);
      if (journal.mutationType === "delete") {
        await options.capabilities.completeRemoval(id, journal.targetRevision);
        await rm(path, { force: true });
        continue;
      }
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
        const prepared =
          journal.credentialMutation ?? (await options.credentials.pending(journal.capabilityId));
        if (prepared !== undefined) await options.credentials.rollback(prepared);
        await rm(path, { force: true });
        continue;
      }
      if (
        journal.stage === "revision-pending" &&
        journal.targetHealth !== undefined &&
        JSON.stringify(latest.health) !== JSON.stringify(journal.targetHealth)
      ) {
        const prepared =
          journal.credentialMutation ?? (await options.credentials.pending(journal.capabilityId));
        if (prepared !== undefined) await options.credentials.rollback(prepared);
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
      if (candidate.health.status !== "ready" && journal.propagate) continue;
      if (journal.stage === "revision-pending" || journal.stage === "revision-written") {
        await assertCompatible(candidate);
      }
      await finishJournal(journal, candidate);
    }
  };

  const assertCompatible = async (candidate: Capability): Promise<void> => {
    const snapshot = await options.project.get();
    assertProjectCompatible(candidate, snapshot.resources);
    assertSystemCompatible(candidate);
  };

  const assertProjectCompatible = (
    candidate: Capability,
    resources: readonly PragmaResource[],
  ): void => {
    const availableTools = new Set(capabilityToolNames(candidate));
    if (candidate.definition.kind === "skill") return;
    const incompatible: string[] = [];
    const boundRefs = new Set(
      resources.flatMap((resource) => {
        const binding = classifyDesktopCapabilityResource(resource);
        return binding?.id === candidate.manifest.id ? [canonicalPragmaResourceRef(resource)] : [];
      }),
    );
    for (const expert of resources.filter(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    )) {
      for (const reference of expert.spec.capabilities) {
        if (reference.kind !== "tools" || !boundRefs.has(reference.ref)) continue;
        const missing = (reference.tools ?? []).filter((tool) => !availableTools.has(tool));
        if (missing.length > 0) {
          incompatible.push(
            `${expert.metadata.name} (${canonicalPragmaResourceRef(expert)}): ${missing.join(", ")}`,
          );
        }
      }
    }
    if (incompatible.length > 0) throwIncompatible(incompatible);
  };

  const assertSystemCompatible = (candidate: Capability): void => {
    if (candidate.definition.kind === "skill") return;
    const availableTools = new Set(capabilityToolNames(candidate));
    const incompatible: string[] = [];
    for (const summary of options.systemExperts.list()) {
      const expert = options.systemExperts.get(summary.ref);
      for (const reference of expert?.capabilities ?? []) {
        if (reference.capabilityId !== candidate.manifest.id || reference.kind !== "tools") {
          continue;
        }
        const missing = reference.toolNames.filter((tool) => !availableTools.has(tool));
        if (missing.length > 0)
          incompatible.push(`${summary.name} (${summary.ref}): ${missing.join(", ")}`);
      }
    }
    if (incompatible.length > 0) throwIncompatible(incompatible);
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
    async mutate(input) {
      await prepareLockRoot();
      await withFileLock(lockPath(input.id), async () => {
        await recoverCapabilityLocked(input.id);
        const latest = await options.capabilities.get(input.id);
        if (latest.manifest.latestRevision !== input.expectedRevision) {
          throw new CapabilityStoreError(
            "revision_conflict",
            `Capability revision changed from ${input.expectedRevision} to ${latest.manifest.latestRevision}.`,
          );
        }
        await input.validateCurrent?.();
        if (input.mutationType === "delete") {
          const timestamp = new Date().toISOString();
          const journal = JournalSchema.parse({
            schemaVersion: "pragma.capability-mutation/v2",
            mutationId: randomUUID(),
            mutationType: "delete",
            capabilityId: input.id,
            baseRevision: input.expectedRevision,
            targetRevision: input.expectedRevision,
            targetRevisionRange: { from: input.expectedRevision, to: input.expectedRevision },
            candidateContentHash: hashContent(`delete:${input.id}:${input.expectedRevision}`),
            stage: "revision-pending",
            createdAt: timestamp,
            updatedAt: timestamp,
            previousHealth: latest.health,
            propagate: false,
          });
          await writeJournal(journal);
          await input.commit();
          await rm(journalPath(input.id, input.expectedRevision), { force: true });
          return;
        }
        await input.commit();
      });
      await cleanupCapabilityDirectory(input.id);
    },
    async publishHealth(input) {
      await prepareLockRoot();
      return await withFileLock(lockPath(input.id), async () => {
        await recoverCapabilityLocked(input.id);
        const latest = await options.capabilities.get(input.id);
        if (latest.manifest.latestRevision !== input.expectedRevision) {
          throw new CapabilityStoreError(
            "revision_conflict",
            `Capability revision changed from ${input.expectedRevision} to ${latest.manifest.latestRevision}.`,
          );
        }
        await input.validateCurrent?.();
        if (input.prepareCredentials === undefined) return await input.commit();
        if (input.targetHealth === undefined) {
          throw new CapabilityStoreError(
            "config_invalid",
            "A credential mutation requires its exact target health snapshot.",
          );
        }
        const timestamp = new Date().toISOString();
        let journal = JournalSchema.parse({
          schemaVersion: "pragma.capability-mutation/v2",
          mutationId: randomUUID(),
          mutationType: "update",
          capabilityId: input.id,
          baseRevision: input.expectedRevision,
          targetRevision: input.expectedRevision,
          targetRevisionRange: { from: input.expectedRevision, to: input.expectedRevision },
          candidateContentHash: hashContent(JSON.stringify(input.targetHealth)),
          stage: "revision-pending",
          createdAt: timestamp,
          updatedAt: timestamp,
          previousHealth: latest.health,
          targetHealth: input.targetHealth,
          propagate: false,
        });
        await writeJournal(journal);
        const prepared = await input.prepareCredentials();
        if (prepared !== undefined) {
          journal = JournalSchema.parse({ ...journal, credentialMutation: prepared });
          await writeJournal(journal);
        }
        const committed = await input.commit();
        await finishJournal(journal, committed);
        return committed;
      });
    },
    async publish(input) {
      const id = input.candidate.manifest.id;
      await prepareLockRoot();
      try {
        return await withFileLock(lockPath(id), async () => {
          await recoverCapabilityLocked(id);
          const latest = await options.capabilities.get(id);
          if (
            latest.manifest.latestRevision !== input.current.manifest.latestRevision ||
            latest.health.revision !== input.current.health.revision
          ) {
            throw new CapabilityStoreError(
              "revision_conflict",
              `Capability revision changed from ${input.current.manifest.latestRevision} to ${latest.manifest.latestRevision}.`,
            );
          }
          await input.validateCurrent?.();
          if (input.candidate.health.status === "ready") await assertCompatible(input.candidate);
          const timestamp = new Date().toISOString();
          let journal = JournalSchema.parse({
            schemaVersion: "pragma.capability-mutation/v2",
            mutationId: randomUUID(),
            mutationType: input.mutationType ?? "update",
            capabilityId: id,
            baseRevision: input.current.manifest.latestRevision,
            targetRevision: input.candidate.manifest.latestRevision,
            targetRevisionRange: {
              from:
                input.targetRevisionFrom ??
                Math.min(
                  input.current.manifest.latestRevision + 1,
                  input.candidate.manifest.latestRevision,
                ),
              to: input.candidate.manifest.latestRevision,
            },
            candidateContentHash: hashContent(JSON.stringify(input.candidate.definition)),
            stage: "revision-pending",
            createdAt: timestamp,
            updatedAt: timestamp,
            previousHealth: input.current.health,
            propagate: input.candidate.health.status === "ready",
          });
          await writeJournal(journal);
          const prepared = await input.prepareCredentials?.();
          if (prepared !== undefined) {
            journal = JournalSchema.parse({ ...journal, credentialMutation: prepared });
            await writeJournal(journal);
          }
          const committed = await input.commit();
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
          const journal = await readJournal(
            join(options.journalRoot, directory.name, firstJournal),
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

function hashContent(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

function throwIncompatible(incompatible: readonly string[]): never {
  throw new CapabilityStoreError(
    "capability_incompatible",
    `Capability update removes tools selected by current Experts: ${incompatible.join("; ")}. Update those Experts first.`,
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
