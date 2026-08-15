import { ipcMain } from "electron";
import { generatePragmaResourceId } from "@pragma/core";
import { runPragmaEvaluation } from "@pragma/interpreter";
import { parsePragmaReference } from "@pragma/interpreter/ast";
import {
  PragmaExpertTeamResourceSchema,
  canonicalPragmaResourceRef,
} from "@pragma/interpreter/ast";

import {
  DeletePragmaResourceSchema,
  PragmaProjectChangesSchema,
  PublishPragmaProjectSchema,
  RunPragmaEvaluationSchema,
  UpsertPragmaResourceSchema,
  UpsertPragmaExpertTeamSchema,
  DesktopPragmaContextStoreBindingSchema,
  ValidatePragmaResourceSchema,
  ValidatePragmaYamlSchema,
} from "../../../shared/contracts/index.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import type { DesktopUsageStore } from "../usage/usage-store.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import {
  classifyDesktopContextResource,
  resolveDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";

export function installPragmaProjectHandlers(
  store: PragmaProjectStore,
  usage: DesktopUsageStore,
  contextStores: ContextStoreStore,
): void {
  ipcMain.handle("pragma-project:get", () => runDesktopMutation(async () => await store.get()));
  ipcMain.handle("pragma-project:allocate-id", () =>
    runDesktopMutation(async () => {
      const used = new Set((await store.get()).resources.map((resource) => resource.metadata.id));
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const id = generatePragmaResourceId();
        if (!used.has(id)) return { id };
      }
      throw new Error("Could not allocate a unique Pragma resource ID.");
    }),
  );
  ipcMain.handle("pragma-project:publish", (_event, input: unknown) =>
    runDesktopMutation(async () => await store.publish(PublishPragmaProjectSchema.parse(input))),
  );
  ipcMain.handle("pragma-project:upsert", (_event, input: unknown) =>
    runDesktopMutation(async () => await store.upsert(UpsertPragmaResourceSchema.parse(input))),
  );
  ipcMain.handle("pragma-project:context-store-bindings", () =>
    runDesktopMutation(async () => {
      const snapshot = await store.get();
      return DesktopPragmaContextStoreBindingSchema.array().parse(
        snapshot.resources.flatMap((resource) => {
          const storeId = classifyDesktopContextResource(resource);
          return storeId === undefined
            ? []
            : [{ storeId, resourceRef: canonicalPragmaResourceRef(resource) }];
        }),
      );
    }),
  );
  ipcMain.handle("pragma-project:upsert-team", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const request = UpsertPragmaExpertTeamSchema.parse(input);
      const snapshot = await store.get();
      const existing = snapshot.resources.find(
        (resource) =>
          resource.kind === "ExpertTeam" && resource.metadata.id === request.resource.metadata.id,
      );
      const seen = new Set<string>();
      const resolved = [];
      for (const selection of request.contextStores) {
        if (seen.has(selection.storeId)) {
          throw new Error(`Knowledge base is selected more than once: ${selection.storeId}`);
        }
        seen.add(selection.storeId);
        await contextStores.resolve(selection.storeId);
        const currentRef =
          existing?.kind === "ExpertTeam"
            ? existing.spec.contextStores.find((binding) => {
                const resource = snapshot.resources.find(
                  (candidate) => canonicalPragmaResourceRef(candidate) === binding.ref,
                );
                return classifyDesktopContextResource(resource) === selection.storeId;
              })?.ref
            : undefined;
        const resource = resolveDesktopContextResource({
          storeId: selection.storeId,
          resources: snapshot.resources,
          currentRef,
        });
        resolved.push({ resource });
      }
      const team = PragmaExpertTeamResourceSchema.parse({
        ...request.resource,
        spec: {
          ...request.resource.spec,
          contextStores: [
            ...request.resource.spec.contextStores,
            ...resolved.map(({ resource }) => ({
              ref: canonicalPragmaResourceRef(resource),
              namespace: `team_${request.resource.metadata.id}_${resource.metadata.id}`,
              required: true,
              visibility: { mode: "all" },
            })),
          ],
        },
      });
      return await store.apply({
        baseRevision: request.baseRevision,
        upserts: [...resolved.map(({ resource }) => resource), team],
        removals: [],
        requiredUnchangedRefs: request.requiredUnchangedRefs,
      });
    }),
  );
  ipcMain.handle("pragma-project:apply-changes", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const changes = PragmaProjectChangesSchema.parse(input);
      const snapshot = await store.apply(changes);
      changes.removals.forEach((ref) => markDeletedUsageSubject(usage, ref));
      return snapshot;
    }),
  );
  ipcMain.handle("pragma-project:delete", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const request = DeletePragmaResourceSchema.parse(input);
      const snapshot = await store.remove(request);
      markDeletedUsageSubject(usage, request.ref);
      return snapshot;
    }),
  );
  ipcMain.handle("pragma-project:validate-yaml", (_event, input: unknown) =>
    store.validateYaml(ValidatePragmaYamlSchema.parse(input).source),
  );
  ipcMain.handle("pragma-project:validate-resource", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = ValidatePragmaResourceSchema.parse(input);
      return await store.validateCandidate(parsed);
    }),
  );
  ipcMain.handle("pragma-project:validate-changes", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = PragmaProjectChangesSchema.parse(input);
      return { diagnostics: await store.validateChanges(parsed) };
    }),
  );
  ipcMain.handle("pragma-project:evaluation:run", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = RunPragmaEvaluationSchema.parse(input);
      const snapshot = await store.get();
      const flow = snapshot.resources.find(
        (resource) =>
          resource.kind === "Flow" &&
          `flow:${resource.metadata.id}` === parsed.evaluation.spec.target.ref,
      );
      if (flow === undefined || flow.kind !== "Flow") {
        throw new Error(`Evaluation target Flow not found: ${parsed.evaluation.spec.target.ref}.`);
      }
      return runPragmaEvaluation(flow, parsed.evaluation);
    }),
  );
}

function markDeletedUsageSubject(usage: DesktopUsageStore, ref: string): void {
  const { kind, id } = parsePragmaReference(ref);
  if (kind === "expert" || kind === "team" || kind === "flow") {
    usage.markSubjectDeleted(kind, id);
  }
}
