import {
  DesktopBundleSetupErrorSchema,
  type PragmaBundleDependencyReadiness,
} from "../../../shared/contracts/index.ts";

export class BundleSetupRequiredError extends Error {
  readonly code = "bundle_setup_required" as const;

  constructor(
    readonly rootRef: string,
    readonly operation: "create_mission" | "run_mission",
    readonly dependencies: readonly PragmaBundleDependencyReadiness[],
    readonly installationId?: string,
  ) {
    super("Complete the required Bundle setup before continuing.");
    this.name = "BundleSetupRequiredError";
    DesktopBundleSetupErrorSchema.parse({
      rootRef,
      operation,
      ...(installationId === undefined ? {} : { installationId }),
      dependencies,
    });
  }
}
