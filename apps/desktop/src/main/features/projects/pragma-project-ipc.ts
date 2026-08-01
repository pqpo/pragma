import { ipcMain } from "electron";
import { generatePragmaResourceId } from "@pragma/core";
import { runPragmaEvaluation } from "@pragma/interpreter";
import { parsePragmaReference } from "@pragma/interpreter/ast";

import {
  DeletePragmaResourceSchema,
  PragmaProjectChangesSchema,
  PublishPragmaProjectSchema,
  RunPragmaEvaluationSchema,
  UpsertPragmaResourceSchema,
  ValidatePragmaResourceSchema,
  ValidatePragmaYamlSchema,
} from "../../../shared/contracts/index.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import type { DesktopUsageStore } from "../usage/usage-store.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";

export function installPragmaProjectHandlers(
  store: PragmaProjectStore,
  usage: DesktopUsageStore,
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
