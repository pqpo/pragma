import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID } from "@pragma/built-in-agents";

import {
  canonicalPragmaResourceRef,
  mergePragmaResourcePreservingUnknownFields,
  PragmaForwardCompatibleResourceSchema,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { z } from "zod";

import {
  CapabilityDefinitionSchema,
  CoreAssetSyncItemSchema,
  WorkflowLayoutSchema,
  type CoreAssetSyncItem,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { scanSkillWorkingTree } from "../capabilities/skill-revision-draft-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import { hashSnapshotContent } from "../context-stores/context-store-store.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import {
  PragmaProjectStoreError,
  type PragmaProjectStore,
} from "../projects/pragma-project-store.ts";
import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";

import {
  bindExistingDesktopCapabilityResource,
  bindExistingDesktopContextResource,
  classifyDesktopCapabilityResource,
  classifyDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";

import { PragmaRuntimeProfileConfigSchema } from "@pragma/interpreter/ast";
import {
  readTransferredSkill,
  readTransferredKnowledge,
  portableKnowledgeContent,
  validateTransferredSkill,
  publishTransferredSkill,
  appendTransferredKnowledge,
  SkillDataSchema,
  KnowledgeDataSchema,
} from "./asset-transfer-payloads.ts";
import { fingerprint } from "./asset-transfer-fingerprint.ts";
export const NAME_RESOLUTION_ERROR_CODE = "core_asset_sync.name_unresolved";
export interface CoreAssetSyncNameResolutionIssue {
  readonly code: typeof NAME_RESOLUTION_ERROR_CODE;
  readonly resourceKey: string;
  readonly resourceKind: "capability" | "context-store";
  readonly bindingId: string;
}
export interface CollectedItems {
  readonly items: ItemMap;
  readonly revisions: ReadonlyMap<string, number>;
  readonly nameResolutionIssues: ReadonlyMap<string, CoreAssetSyncNameResolutionIssue>;
}

/** Transport payloads are validated independently of the Bundle and Git encodings. */
export const AssetTransferItemSchema = CoreAssetSyncItemSchema.extend({
  data: z.union([
    PragmaForwardCompatibleResourceSchema,
    CapabilityDefinitionSchema,
    KnowledgeDataSchema,
    SkillDataSchema,
    WorkflowLayoutSchema.pick({ nodes: true, viewport: true }),
  ]),
});
export type AssetTransferItem = z.infer<typeof AssetTransferItemSchema>;

type ItemMap = Map<string, AssetTransferItem>;
export interface AssetTransferChange {
  readonly key: string;
  readonly expectedRevision?: number | undefined;
  readonly local?: CoreAssetSyncItem | undefined;
  readonly remote?: CoreAssetSyncItem | undefined;
}
export function createAssetTransferService(options: {
  readonly project: PragmaProjectStore;
  readonly layouts: WorkflowLayoutStore;
  readonly stores: ContextStoreStore;
  readonly capabilities: CapabilityStore;
  readonly reportNameResolutionFailure: (
    key: string,
    kind: CoreAssetSyncNameResolutionIssue["resourceKind"],
    bindingId: string,
  ) => CoreAssetSyncNameResolutionIssue;
}) {
  const collectAssets = async (): Promise<CollectedItems> => {
    const result: ItemMap = new Map();
    const revisions = new Map<string, number>();
    const nameResolutionIssues = new Map<string, CoreAssetSyncNameResolutionIssue>();
    const add = (
      kind: CoreAssetSyncItem["kind"],
      id: string,
      name: string,
      data: unknown,
    ): void => {
      const key = `${kind}:${id}`;
      const parsed = AssetTransferItemSchema.parse({
        key,
        kind,
        name,
        fingerprint: fingerprint(data),
        data,
      });
      result.set(key, { ...parsed, fingerprint: fingerprint(parsed.data) });
    };
    const [initialSnapshot, stores, capabilities] = await Promise.all([
      options.project.get(),
      options.stores.list(),
      options.capabilities.list(),
    ]);
    let snapshot = initialSnapshot;
    const storesById = new Map(stores.map((store) => [store.id, store] as const));
    const capabilitiesById = new Map(
      capabilities.map((capability) => [capability.manifest.id, capability] as const),
    );
    // Reconcile deleted authorities, while retaining referenced or unreadable assets.
    const dependencies = referencedPragmaResourceRefs(snapshot.resources);
    const orphanCandidates = snapshot.resources.flatMap<{
      ref: string;
      id: string;
      kind: "capability" | "knowledge";
    }>((resource) => {
      const binding = classifyDesktopCapabilityResource(resource);
      const storeId = classifyDesktopContextResource(resource);
      const ref = canonicalPragmaResourceRef(resource);
      if (dependencies.has(ref)) return [];
      if (
        binding !== undefined &&
        binding.id !== PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID &&
        !capabilitiesById.has(binding.id)
      )
        return [{ ref, id: binding.id, kind: "capability" as const }];
      if (storeId !== undefined && !storesById.has(storeId))
        return [{ ref, id: storeId, kind: "knowledge" as const }];
      return [];
    });
    // Reconcile each binding independently: an external System Expert dependency
    // must not prevent unrelated orphaned bindings from being cleaned up.
    for (const candidate of orphanCandidates) {
      const currentResource = snapshot.resources.find(
        (resource) => canonicalPragmaResourceRef(resource) === candidate.ref,
      );
      if (
        currentResource === undefined ||
        (candidate.kind === "knowledge"
          ? classifyDesktopContextResource(currentResource)
          : classifyDesktopCapabilityResource(currentResource)?.id) !== candidate.id ||
        referencedPragmaResourceRefs(snapshot.resources).has(candidate.ref)
      )
        continue;
      const exists =
        candidate.kind === "knowledge"
          ? await options.stores.exists(candidate.id)
          : await options.capabilities.exists(candidate.id);
      if (exists) continue;
      try {
        snapshot = await options.project.remove({
          baseRevision: snapshot.revision,
          ref: candidate.ref,
        });
      } catch (error) {
        if (
          !(error instanceof PragmaProjectStoreError) ||
          !["resource_referenced", "resource_not_found", "revision_conflict"].includes(error.code)
        )
          throw error;
        // Another overview or publication may already have removed or mounted this
        // binding. Use the authoritative head and defer contested cleanup to the next read.
        snapshot = await options.project.get();
      }
    }
    const resources = snapshot.resources.filter((resource) => {
      if (resource.kind === "Capability") {
        const binding = classifyDesktopCapabilityResource(resource);
        return binding !== undefined && binding.id !== PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID;
      }
      if (resource.kind === "ContextStore")
        return classifyDesktopContextResource(resource) !== undefined;
      return ["Expert", "ExpertTeam", "Flow", "RuntimeProfile"].includes(resource.kind);
    });
    for (const resource of resources) {
      const kind =
        resource.kind === "Expert"
          ? "expert"
          : resource.kind === "ExpertTeam"
            ? "team"
            : resource.kind === "Flow"
              ? "flow"
              : resource.kind === "RuntimeProfile"
                ? "runtime-profile"
                : resource.kind === "Capability"
                  ? "capability"
                  : "knowledge";
      let portable: PragmaResource = resource;
      let name = resource.metadata.name;
      if (resource.kind === "ContextStore") {
        const bindingId = classifyDesktopContextResource(resource);
        const store = bindingId === undefined ? undefined : storesById.get(bindingId);
        if (store !== undefined) {
          name = store.name;
          portable = bindExistingDesktopContextResource(resource, store.id, {
            name: store.name,
            description: store.description,
          });
        } else if (bindingId !== undefined) {
          const key = `${kind}:${canonicalPragmaResourceRef(resource)}`;
          nameResolutionIssues.set(
            key,
            options.reportNameResolutionFailure(key, "context-store", bindingId),
          );
        }
      } else if (resource.kind === "Capability") {
        const binding = classifyDesktopCapabilityResource(resource);
        if (binding !== undefined) {
          const capability = capabilitiesById.get(binding.id);
          if (capability !== undefined) {
            name = capability.definition.name;
            portable = bindExistingDesktopCapabilityResource(resource, binding, {
              name: capability.definition.name,
              description: capability.definition.description,
            });
          } else {
            const key = `${kind}:${canonicalPragmaResourceRef(resource)}`;
            nameResolutionIssues.set(
              key,
              options.reportNameResolutionFailure(key, "capability", binding.id),
            );
          }
        }
      }
      if (portable.kind === "RuntimeProfile") {
        PragmaRuntimeProfileConfigSchema.parse(portable.spec.config);
      }
      add(kind, canonicalPragmaResourceRef(resource), name, portable);
      if (resource.kind === "Flow") {
        const layout = await options.layouts.get({
          projectId: snapshot.projectId,
          flowId: resource.metadata.id,
        });
        if (layout !== null)
          add("flow-layout", resource.metadata.id, resource.metadata.name, {
            nodes: layout.nodes,
            viewport: layout.viewport,
          });
      }
    }
    for (const store of stores) {
      const storeSnapshot = await readTransferredKnowledge(options.stores, store.id);
      if (store.contentRevision !== storeSnapshot.snapshot.revision)
        throw new Error(
          "asset_sync.local_changed: Knowledge changed while collecting its snapshot.",
        );
      revisions.set(`knowledge:${store.id}`, store.contentRevision);
      add("knowledge", store.id, store.name, {
        name: store.name,
        description: store.description,
        directories: storeSnapshot.directories,
        files: storeSnapshot.files,
      });
    }
    for (const capability of capabilities) {
      if (
        capability.managedBy === "system" ||
        capability.manifest.id === PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID
      )
        continue;
      const id = capability.manifest.id;
      revisions.set(
        `${capability.definition.kind === "skill" ? "skill" : "capability"}:${id}`,
        capability.manifest.latestRevision,
      );
      if (capability.definition.kind !== "skill") {
        add("capability", id, capability.definition.name, capability.definition);
        continue;
      }
      const root = await options.capabilities.skillFilesPath(
        id,
        capability.manifest.latestRevision,
      );
      const payload = await readTransferredSkill(root, capability.definition.executablePaths);
      const files = payload.files;
      add(
        "skill",
        id,
        capability.definition.name,
        SkillDataSchema.parse({
          name: capability.definition.name,
          description: capability.definition.description,
          files,
        }),
      );
    }
    return { items: result, revisions, nameResolutionIssues };
  };

  const prepareImport = async (
    changes: readonly AssetTransferChange[],
  ): Promise<readonly AssetTransferChange[]> => {
    if (changes.length === 0) return changes;
    const current = await options.project.get();
    const prepared: AssetTransferChange[] = [];
    const replacements = new Set<string>();
    const upserts: PragmaResource[] = [];
    const [capabilities, stores] = await Promise.all([
      options.capabilities.list(),
      options.stores.list(),
    ]);
    const definitions = new Map(
      capabilities.map((capability) => [capability.manifest.id, capability.definition]),
    );
    const removedPayloads = new Set<string>();
    const capabilityIds = new Set(definitions.keys());
    const storeIds = new Set(stores.map((store) => store.id));
    for (const sourceChange of changes) {
      let change = sourceChange;
      if (change.remote) AssetTransferItemSchema.parse(change.remote);
      const item = change.remote ?? change.local;
      if (!item) continue;
      if (!isResourceItem(item)) {
        const id = item.key.slice(item.kind.length + 1);
        if (item.kind === "capability" || item.kind === "skill") {
          const existing = capabilities.find((capability) => capability.manifest.id === id);
          if (id === PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID || existing?.managedBy === "system")
            throw new Error("System Capability cannot be synchronized.");
          if (change.remote && existing) {
            const kind =
              item.kind === "skill"
                ? "skill"
                : CapabilityDefinitionSchema.parse(change.remote.data).kind;
            if (kind !== existing.definition.kind)
              throw new Error("Incoming Capability kind cannot be changed.");
          }
        }
        const ids =
          item.kind === "knowledge"
            ? storeIds
            : item.kind === "skill" || item.kind === "capability"
              ? capabilityIds
              : undefined;
        if (change.remote) ids?.add(id);
        else {
          ids?.delete(id);
          if (ids) removedPayloads.add(item.key);
          if (item.kind === "skill" || item.kind === "capability") definitions.delete(id);
        }
      }
      if (isResourceItem(item)) {
        replacements.add(item.key.slice(item.kind.length + 1));
        if (change.remote) {
          const incoming = PragmaForwardCompatibleResourceSchema.parse(change.remote.data);
          const existing = current.resources.find(
            (resource) =>
              canonicalPragmaResourceRef(resource) === canonicalPragmaResourceRef(incoming),
          );
          const resource = existing
            ? mergePragmaResourcePreservingUnknownFields(existing, incoming)
            : incoming;
          change = {
            ...change,
            remote: { ...change.remote, data: resource, fingerprint: fingerprint(resource) },
          };
          if (resource.kind === "RuntimeProfile")
            PragmaRuntimeProfileConfigSchema.parse(resource.spec.config);
          upserts.push(resource);
        }
      } else if (change.remote?.kind === "knowledge") {
        const data = KnowledgeDataSchema.parse(change.remote.data);
        for (const file of data.files)
          if (Buffer.byteLength(file.content) > 1_000_000)
            throw new Error(`Knowledge file exceeds 1 MB: ${file.id}`);
      } else if (change.remote?.kind === "skill")
        validateTransferredSkill(SkillDataSchema.parse(change.remote.data));
      else if (change.remote?.kind === "capability")
        definitions.set(
          item.key.slice("capability:".length),
          CapabilityDefinitionSchema.parse(change.remote.data),
        );
      prepared.push(change);
    }
    const desired = [
      ...current.resources.filter(
        (resource) => !replacements.has(canonicalPragmaResourceRef(resource)),
      ),
      ...upserts,
    ];
    const requiredRefs = new Set(referencedPragmaResourceRefs(upserts));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const resource of desired) {
        if (!requiredRefs.has(canonicalPragmaResourceRef(resource))) continue;
        for (const ref of referencedPragmaResourceRefs([resource]))
          if (!requiredRefs.has(ref)) {
            requiredRefs.add(ref);
            expanded = true;
          }
      }
    }
    for (const resource of desired) {
      const changedOrRequired =
        replacements.has(canonicalPragmaResourceRef(resource)) ||
        requiredRefs.has(canonicalPragmaResourceRef(resource));
      const storeId = classifyDesktopContextResource(resource);
      const capabilityId = classifyDesktopCapabilityResource(resource)?.id;
      if (
        storeId &&
        !storeIds.has(storeId) &&
        (changedOrRequired || removedPayloads.has(`knowledge:${storeId}`))
      )
        throw new Error(`Incoming ContextStore refers to missing knowledge: ${storeId}`);
      if (
        capabilityId &&
        !capabilityIds.has(capabilityId) &&
        (changedOrRequired ||
          removedPayloads.has(`capability:${capabilityId}`) ||
          removedPayloads.has(`skill:${capabilityId}`))
      )
        throw new Error(`Incoming Capability refers to missing definition: ${capabilityId}`);
      if (resource.kind !== "Expert") continue;
      for (const ref of resource.spec.capabilities) {
        if (ref.kind !== "tools") continue;
        const binding = desired.find(
          (candidate) => canonicalPragmaResourceRef(candidate) === ref.ref,
        );
        const id =
          binding === undefined ? undefined : classifyDesktopCapabilityResource(binding)?.id;
        const definition = id === undefined ? undefined : definitions.get(id);
        if (!definition) continue;
        const tools = new Set(
          definition.kind === "code_service"
            ? [definition.tool.name]
            : definition.kind === "skill"
              ? []
              : definition.tools.map((tool) => tool.name),
        );
        if ((ref.tools ?? []).some((tool) => !tools.has(tool)))
          throw new Error(`Incoming Capability lacks tools selected by ${resource.metadata.name}.`);
      }
    }
    if (upserts.length || replacements.size) {
      const diagnostics = await options.project.validateChanges({
        baseRevision: current.revision,
        upserts,
        removals: [...replacements].filter(
          (ref) => !upserts.some((resource) => canonicalPragmaResourceRef(resource) === ref),
        ),
      });
      const error = diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (error) throw new Error(`Incoming project is invalid: ${error.message}`);
    }
    return prepared;
  };
  const applyImport = async (changes: readonly AssetTransferChange[]): Promise<void> => {
    const initialProject = await options.project.get();
    const assertExpected = (key: string, currentData: unknown, revision?: number): void => {
      const change = changes.find((candidate) => candidate.key === key);
      if (!change) return;
      const currentHash = currentData === undefined ? undefined : fingerprint(currentData);
      if (
        change.expectedRevision !== undefined &&
        revision !== change.expectedRevision &&
        currentHash !== change.remote?.fingerprint
      )
        throw new Error(
          `asset_sync.restore_conflict: Local asset revision changed during restore: ${key}`,
        );
      if (currentHash !== change.local?.fingerprint && currentHash !== change.remote?.fingerprint)
        throw new Error(`asset_sync.restore_conflict: Local asset changed during restore: ${key}`);
    };
    const projectUpserts: PragmaResource[] = [];
    const projectRemovals: string[] = [];
    const deferredRemovals: { kind: "knowledge" | "skill" | "capability"; id: string }[] = [];
    const capabilityUpdates: {
      id: string;
      definition: Exclude<z.infer<typeof CapabilityDefinitionSchema>, { kind: "skill" }>;
    }[] = [];
    for (const { remote } of changes) {
      if (remote?.kind !== "capability" || remote.key.startsWith("capability:capability:"))
        continue;
      const definition = CapabilityDefinitionSchema.parse(remote.data);
      if (definition.kind === "skill") throw new Error("Skill payload is missing.");
      capabilityUpdates.push({ id: remote.key.slice("capability:".length), definition });
    }
    for (const { local, remote } of changes) {
      const item = remote ?? local;
      if (item === undefined) continue;
      if (
        ["expert", "team", "flow", "runtime-profile"].includes(item.kind) ||
        (item.kind === "capability" && item.key.startsWith("capability:capability:")) ||
        (item.kind === "knowledge" && item.key.startsWith("knowledge:context-store:"))
      ) {
        if (remote === undefined) {
          const current = (await options.project.get()).resources.find(
            (candidate) =>
              canonicalPragmaResourceRef(candidate) === item.key.slice(item.kind.length + 1),
          );
          if (current) projectRemovals.push(item.key.slice(item.kind.length + 1));
        } else {
          const resource = PragmaForwardCompatibleResourceSchema.parse(remote.data);
          const current = (await options.project.get()).resources.find(
            (candidate) =>
              canonicalPragmaResourceRef(candidate) === canonicalPragmaResourceRef(resource),
          );
          if (fingerprint(current) !== fingerprint(resource)) projectUpserts.push(resource);
        }
        continue;
      }
      if (item.kind === "flow-layout") {
        const flowId = item.key.slice("flow-layout:".length);
        const current = await options.layouts.get({ projectId: options.project.projectId, flowId });
        const expected =
          current === null ? null : { nodes: current.nodes, viewport: current.viewport };
        assertExpected(item.key, expected ?? undefined);
        if (remote === undefined)
          await options.layouts.remove({ projectId: options.project.projectId, flowId }, expected);
        else {
          const layout = z
            .object({
              nodes: WorkflowLayoutSchema.shape.nodes,
              viewport: WorkflowLayoutSchema.shape.viewport,
            })
            .parse(remote.data);
          await options.layouts.save(
            {
              ...layout,
              schemaVersion: "pragma.desktop-flow-layout/v2",
              projectId: options.project.projectId,
              flowId,
              updatedAt: new Date().toISOString(),
            },
            expected,
          );
        }
        continue;
      }
      if (item.kind === "knowledge") {
        const id = item.key.slice("knowledge:".length);
        const localStore = (await options.stores.list()).find((candidate) => candidate.id === id);
        if (remote === undefined) {
          if (localStore) deferredRemovals.push({ kind: "knowledge", id });
          continue;
        }
        const data = KnowledgeDataSchema.parse(remote.data);
        if (localStore !== undefined) {
          const snapshot = await options.stores.getSnapshot(id);
          const portable = portableKnowledgeContent(snapshot);
          assertExpected(
            item.key,
            {
              name: localStore.name,
              description: localStore.description,
              ...portable,
            },
            localStore.contentRevision,
          );
          if (
            localStore.name === data.name &&
            localStore.description === data.description &&
            hashSnapshotContent(portable.files, portable.directories) === hashKnowledge(data)
          )
            continue;
        }
        if (localStore === undefined) {
          assertExpected(item.key, undefined);
          await options.stores.createFromSnapshot({
            id,
            ...data,
            author: "sync",
            summary: "Restore core assets from Git.",
          });
        } else
          await appendTransferredKnowledge(
            options.stores,
            {
              storeId: id,
              baseRevision: localStore.contentRevision,
              baseSnapshotHash: localStore.snapshotHash,
              snapshotHash: hashKnowledge(data),
              ...data,
              summary: "Restore core assets from Git.",
            },
            "sync",
          );
        continue;
      }
      const id = item.key.slice(item.kind.length + 1);
      const localCapability = (await options.capabilities.list()).find(
        (candidate) => candidate.manifest.id === id,
      );
      if (remote === undefined) {
        if (localCapability)
          deferredRemovals.push({ kind: item.kind === "skill" ? "skill" : "capability", id });
        continue;
      }
      if (item.kind === "capability") {
        const definition = CapabilityDefinitionSchema.parse(remote.data);
        if (definition.kind === "skill") throw new Error("Skill payload is missing.");
        continue;
      }
      if (item.kind === "skill") {
        const data = SkillDataSchema.parse(remote.data);
        if (localCapability?.definition.kind === "skill") {
          const root = await options.capabilities.skillFilesPath(
            id,
            localCapability.manifest.latestRevision,
          );
          const payload = await readTransferredSkill(
            root,
            localCapability.definition.executablePaths,
          );
          assertExpected(
            item.key,
            {
              name: localCapability.definition.name,
              description: localCapability.definition.description,
              files: payload.files,
            },
            localCapability.manifest.latestRevision,
          );
          if (
            fingerprint({
              name: localCapability.definition.name,
              description: localCapability.definition.description,
              files: payload.files,
            }) === fingerprint(data)
          )
            continue;
        }
        if (localCapability === undefined) assertExpected(item.key, undefined);
        validateTransferredSkill(data);
        const root = await mkdtemp(join(tmpdir(), "pragma-core-skill-"));
        try {
          for (const file of data.files) {
            const path = join(root, file.path);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, Buffer.from(file.content, "base64"), {
              mode: file.executable ? 0o700 : 0o600,
            });
          }
          const tree = await scanSkillWorkingTree(root, {
            executablePaths: new Set(
              data.files.filter((file) => file.executable).map((file) => file.path),
            ),
          });
          const executablePaths = data.files
            .filter((file) => file.executable)
            .map((file) => file.path);
          await publishTransferredSkill(options.capabilities, {
            id,
            name: data.name,
            description: data.description,
            sourcePath: root,
            candidateContentHash: tree.hash,
            executablePaths,
            ...(localCapability === undefined ? {} : { current: localCapability }),
          });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
    const current = initialProject;
    const replaced = new Set([
      ...projectRemovals,
      ...projectUpserts.map(canonicalPragmaResourceRef),
    ]);
    const desiredResources = [
      ...current.resources.filter(
        (resource) => !replaced.has(canonicalPragmaResourceRef(resource)),
      ),
      ...projectUpserts,
    ];
    const referencedTools = (resources: readonly PragmaResource[], id: string): string[] => {
      const refs = new Set(
        resources.flatMap((resource) =>
          classifyDesktopCapabilityResource(resource)?.id === id
            ? [canonicalPragmaResourceRef(resource)]
            : [],
        ),
      );
      return resources.flatMap((resource) =>
        resource.kind === "Expert"
          ? resource.spec.capabilities.flatMap((reference) =>
              reference.kind === "tools" && refs.has(reference.ref) ? (reference.tools ?? []) : [],
            )
          : [],
      );
    };
    const availableTools = (definition: z.infer<typeof CapabilityDefinitionSchema>): Set<string> =>
      new Set(
        definition.kind === "code_service"
          ? [definition.tool.name]
          : definition.kind === "skill"
            ? []
            : definition.tools.map((tool) => tool.name),
      );
    let projectFirst = false;
    for (const { id, definition } of capabilityUpdates) {
      const tools = availableTools(definition);
      const missingDesired = referencedTools(desiredResources, id).filter(
        (tool) => !tools.has(tool),
      );
      if (missingDesired.length > 0)
        throw new Error(
          `Incoming Capability ${id} lacks tools selected by incoming Experts: ${missingDesired.join(", ")}.`,
        );
      if (referencedTools(current.resources, id).some((tool) => !tools.has(tool)))
        projectFirst = true;
    }
    const projectChanges = {
      baseRevision: current.revision,
      upserts: projectUpserts,
      removals: projectRemovals,
    };
    const hasProjectChanges = projectUpserts.length > 0 || projectRemovals.length > 0;
    if (hasProjectChanges) {
      const diagnostics = await options.project.validateChanges(projectChanges);
      const error = diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (error) throw new Error(`Incoming project is invalid: ${error.message}`);
    }
    if (projectFirst && hasProjectChanges) await options.project.apply(projectChanges);
    for (const { id, definition } of capabilityUpdates) {
      const localCapability = (await options.capabilities.list()).find(
        (candidate) => candidate.manifest.id === id,
      );
      assertExpected(
        `capability:${id}`,
        localCapability?.definition,
        localCapability?.manifest.latestRevision,
      );
      if (localCapability === undefined)
        await options.capabilities.create(
          { definition, credentials: {} },
          { id, preserveDefinition: true },
        );
      else if (fingerprint(localCapability.definition) !== fingerprint(definition))
        await options.capabilities.update(
          {
            id,
            baseRevision: localCapability.manifest.latestRevision,
            definition,
            credentials: {},
          },
          { preserveDefinition: true },
        );
    }
    if (!projectFirst && hasProjectChanges) await options.project.apply(projectChanges);
    for (const removal of deferredRemovals) {
      if (removal.kind === "knowledge") {
        const store = (await options.stores.list()).find(
          (candidate) => candidate.id === removal.id,
        );
        if (store) {
          const snapshot = await options.stores.getSnapshot(removal.id);
          assertExpected(
            `knowledge:${removal.id}`,
            {
              name: store.name,
              description: store.description,
              ...portableKnowledgeContent(snapshot),
            },
            store.contentRevision,
          );
          await options.stores.remove(removal.id, {
            revision: store.contentRevision,
            snapshotHash: store.snapshotHash,
          });
        }
      } else {
        const capability = (await options.capabilities.list()).find(
          (candidate) => candidate.manifest.id === removal.id,
        );
        if (capability) {
          if (capability.definition.kind === "skill") {
            const root = await options.capabilities.skillFilesPath(
              removal.id,
              capability.manifest.latestRevision,
            );
            const payload = await readTransferredSkill(root, capability.definition.executablePaths);
            assertExpected(
              `skill:${removal.id}`,
              {
                name: capability.definition.name,
                description: capability.definition.description,
                files: payload.files,
              },
              capability.manifest.latestRevision,
            );
          } else
            assertExpected(
              `capability:${removal.id}`,
              capability.definition,
              capability.manifest.latestRevision,
            );
          await options.capabilities.remove(removal.id, capability.manifest.latestRevision);
        }
      }
    }
  };

  return { collectAssets, prepareImport, applyImport };
}
export function isResourceItem(item: CoreAssetSyncItem): boolean {
  return (
    ["expert", "team", "flow", "runtime-profile"].includes(item.kind) ||
    item.key.startsWith("capability:capability:") ||
    item.key.startsWith("knowledge:context-store:")
  );
}
function hashKnowledge(data: z.infer<typeof KnowledgeDataSchema>): string {
  return hashSnapshotContent(data.files, data.directories);
}
