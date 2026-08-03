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
    await plane.wakeEpisodicJobs();
    return DesktopMemoryExtractorProfileSchema.parse(profile);
  });
}
