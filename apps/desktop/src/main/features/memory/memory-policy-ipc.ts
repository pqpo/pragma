import { ipcMain } from "electron";

import {
  DesktopAssetMemoryPolicySnapshotSchema,
  DesktopGlobalMemoryPolicySnapshotSchema,
  DesktopMemoryPlaneStatusSchema,
  DesktopMemoryExtractorProfileSchema,
  GetDesktopAssetMemoryPolicySchema,
  UpdateDesktopAssetMemoryPolicySchema,
  UpdateDesktopGlobalMemoryPolicySchema,
  UpdateDesktopMemoryExtractorProfileSchema,
  DesktopSemanticFactListSchema,
  DesktopSemanticFactSchema,
  GetDesktopSemanticFactSchema,
  ListDesktopSemanticFactsSchema,
  SearchDesktopSemanticFactsSchema,
  ReviseDesktopSemanticFactSchema,
  ReviewDesktopSemanticFactSchema,
} from "../../../shared/contracts/index.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";

export function installMemoryPolicyHandlers(plane: DesktopMemoryPlane): void {
  const globalSnapshot = async () => {
    const revision = await plane.policies.getGlobal();
    return DesktopGlobalMemoryPolicySnapshotSchema.parse({
      revision: revision.revision,
      effectiveFrom: revision.effectiveFrom,
      policy: revision.policy,
    });
  };
  const assetSnapshot = async (targetRef: { readonly type: string; readonly id: string }) => {
    const revision = await plane.policies.getOverride(targetRef);
    const effective = await plane.policies.resolveAt({
      rootRef: targetRef,
      occurredAt: new Date().toISOString(),
    });
    return DesktopAssetMemoryPolicySnapshotSchema.parse({
      targetRef,
      revision: revision.revision,
      effectiveFrom: revision.effectiveFrom,
      policy: revision.policy,
      effective,
    });
  };

  ipcMain.handle("memory-policy:global:get", globalSnapshot);
  ipcMain.handle("memory-policy:global:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopGlobalMemoryPolicySchema.parse(input);
    await plane.policies.updateGlobal(parsed);
    return await globalSnapshot();
  });
  ipcMain.handle("memory-policy:asset:get", async (_event, input: unknown) => {
    const parsed = GetDesktopAssetMemoryPolicySchema.parse(input);
    return await assetSnapshot(parsed.targetRef);
  });
  ipcMain.handle("memory-policy:asset:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopAssetMemoryPolicySchema.parse(input);
    await plane.policies.updateOverride(parsed);
    return await assetSnapshot(parsed.targetRef);
  });
  ipcMain.handle("memory-plane:status", async () =>
    DesktopMemoryPlaneStatusSchema.parse(await plane.getStatus()),
  );
  ipcMain.handle("memory-extractor-profile:get", async () =>
    DesktopMemoryExtractorProfileSchema.parse(await plane.extractorProfiles.get()),
  );
  ipcMain.handle("memory-extractor-profile:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopMemoryExtractorProfileSchema.parse(input);
    const profile = await plane.extractorProfiles.update(parsed);
    await plane.wakeMemoryJobs();
    return DesktopMemoryExtractorProfileSchema.parse(profile);
  });
  ipcMain.handle("memory-semantic:list", async (_event, input: unknown) => {
    const parsed = ListDesktopSemanticFactsSchema.parse(input);
    const facts = (await plane.semanticStore.list())
      .filter((fact) => parsed.status === "all" || fact.status === parsed.status)
      .filter(
        (fact) =>
          parsed.subjectRef === undefined ||
          fact.subjectRefs.some(
            (ref) => ref.type === parsed.subjectRef!.type && ref.id === parsed.subjectRef!.id,
          ),
      )
      .slice(0, parsed.limit);
    return DesktopSemanticFactListSchema.parse(facts);
  });
  ipcMain.handle("memory-semantic:search", async (_event, input: unknown) => {
    const parsed = SearchDesktopSemanticFactsSchema.parse(input);
    const facts = (await plane.semanticStore.search(parsed.query, parsed.limit * 2))
      .filter((fact) => parsed.status === "all" || fact.status === parsed.status)
      .slice(0, parsed.limit);
    return DesktopSemanticFactListSchema.parse(facts);
  });
  ipcMain.handle("memory-semantic:get", async (_event, input: unknown) => {
    const parsed = GetDesktopSemanticFactSchema.parse(input);
    const fact = await plane.semanticStore.get(parsed.id);
    if (fact === undefined) throw new Error("semantic_fact_not_found");
    return DesktopSemanticFactSchema.parse(fact);
  });
  ipcMain.handle("memory-semantic:history", async (_event, input: unknown) => {
    const parsed = GetDesktopSemanticFactSchema.parse(input);
    return DesktopSemanticFactListSchema.parse(await plane.semanticStore.history(parsed.id));
  });
  ipcMain.handle("memory-semantic:revise", async (_event, input: unknown) => {
    const parsed = ReviseDesktopSemanticFactSchema.parse(input);
    return DesktopSemanticFactSchema.parse(await plane.reviseSemanticFact(parsed));
  });
  ipcMain.handle("memory-semantic:verify", async (_event, input: unknown) => {
    const parsed = ReviewDesktopSemanticFactSchema.parse(input);
    return DesktopSemanticFactSchema.parse(await plane.verifySemanticFact(parsed));
  });
  ipcMain.handle("memory-semantic:invalidate", async (_event, input: unknown) => {
    const parsed = ReviewDesktopSemanticFactSchema.parse(input);
    return DesktopSemanticFactSchema.parse(await plane.invalidateSemanticFact(parsed));
  });
}
