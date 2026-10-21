import type { PragmaLogger } from "@pragma/core";
import type { PragmaResource } from "@pragma/interpreter/ast";
import { missionTargetRuntimeIds, type LocalHostMissionCompileScope } from "@pragma/local-host";
import {
  BundleSetupRequiredError,
  getTargetRuntimeAvailability,
  type PragmaBundleService,
  type PragmaProjectStore,
  type RuntimeEnvironmentService,
} from "@pragma/local-host/deployment";
import { PragmaProjectSnapshotSchema, type Mission } from "../../../shared/contracts/index.ts";
import { unavailableCoreAssetRuntimeBindings } from "../studio-sync/core-asset-sync-service.ts";

/** Shared by Mission creation and execution admission. */
export function createBundleExecutorReadiness(options: {
  readonly project: Pick<PragmaProjectStore, "get">;
  readonly runtimes: RuntimeEnvironmentService;
  readonly bundles: Pick<PragmaBundleService, "getReadinessForRef">;
  readonly getExternalResource?: (ref: string) => PragmaResource | undefined;
  readonly logger?: PragmaLogger;
}) {
  return async (
    ref: string,
    operation: "create_mission" | "run_mission",
    scope?: LocalHostMissionCompileScope<Mission>,
  ): Promise<void> => {
    const measure = async <T>(phase: string, read: () => Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      try {
        return await read();
      } finally {
        options.logger?.info("mission.readiness_phase", "Executor readiness phase completed", {
          ref,
          operation,
          phase,
          elapsedMs: performance.now() - startedAt,
        });
      }
    };
    const projectSnapshot = await measure("project_snapshot", async () =>
      scope === undefined
        ? await options.project.get()
        : PragmaProjectSnapshotSchema.parse(await scope.getRevision()),
    );
    const runtimeIds = missionTargetRuntimeIds(ref, projectSnapshot.resources, (target) =>
      options.getExternalResource?.(target),
    );
    const runtimesAvailable = await measure("runtime_availability", () =>
      getTargetRuntimeAvailability(options.runtimes, runtimeIds, { includeModels: true }),
    );
    const dependencies = [
      ...(await measure("bundle_readiness", () =>
        options.bundles.getReadinessForRef(ref, {
          snapshot: projectSnapshot,
          runtimes: runtimesAvailable,
        }),
      )),
    ];
    for (const missing of unavailableCoreAssetRuntimeBindings(
      ref,
      projectSnapshot.resources,
      runtimesAvailable,
      { validateModels: false },
    )) {
      if (
        dependencies.some(
          (dependency) => dependency.kind === "runtime" && dependency.resourceRef === missing.ref,
        )
      )
        continue;
      dependencies.push({
        id: `core-asset-runtime:${missing.ref}`,
        kind: "runtime",
        resourceRef: missing.ref,
        name: missing.name,
        status: "action_required",
        code: "core_asset_runtime_binding_missing",
        action: "choose_runtime",
        message: "Choose an available local harness and model before running this asset.",
      });
    }
    if (dependencies.length === 0) return;
    throw new BundleSetupRequiredError(
      ref,
      operation,
      dependencies,
      dependencies.find((dependency) => dependency.installationId !== undefined)?.installationId,
    );
  };
}
