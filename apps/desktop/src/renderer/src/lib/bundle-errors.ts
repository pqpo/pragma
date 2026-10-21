import { DesktopMutationErrorSchema } from "@pragma/local-host/deployment-contracts";

import { errorMessage } from "./errors.ts";

export function isBundlePluginUnavailableError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "bundle_plugin_unavailable") return true;
  }
  return errorMessage(error).includes("bundle_plugin_unavailable:");
}

export function localizedBundleMutationError(
  error: unknown,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parsed = DesktopMutationErrorSchema.safeParse(error);
  if (!parsed.success || parsed.data.code !== "bundle_setup_required") {
    return errorMessage(error);
  }
  const dependencies = parsed.data.bundleSetup?.dependencies.filter(
    (dependency) => dependency.status !== "ready",
  );
  if (dependencies === undefined || dependencies.length === 0) {
    return translate("bundleSetupRequired");
  }
  const names = dependencies
    .slice(0, 3)
    .map((dependency) => bundleDependencyDisplayName(dependency.kind, dependency.name, translate));
  const remaining = dependencies.length - names.length;
  const resources = remaining > 0 ? `${names.join(", ")} (+${remaining})` : names.join(", ");
  return translate("bundleSetupRequired", {
    count: dependencies.length,
    resources,
  });
}

export function bundleDependencyDisplayName(
  kind: string,
  name: string,
  translate: (key: string) => string,
): string {
  const legacyIdentity =
    /^(?:Context|Capability|Runtime(?: Profile)?)\s+(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-hjkmnp-tv-z]{16})$/iu;
  if (!legacyIdentity.test(name)) return name;
  return translate(
    kind === "context-store"
      ? "bundleLegacyKnowledgeBase"
      : kind === "capability"
        ? "bundleLegacyCapability"
        : "bundleLegacyRuntime",
  );
}
