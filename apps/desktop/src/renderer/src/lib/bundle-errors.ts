import { DesktopMutationErrorSchema } from "../../../shared/contracts/mutation.ts";

import { errorMessage } from "./errors.ts";

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
    .map((dependency) =>
      dependency.kind === "context-store" &&
      /^Context\s+[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(dependency.name)
        ? translate("bundleLegacyKnowledgeBase")
        : dependency.name,
    );
  const remaining = dependencies.length - names.length;
  const resources = remaining > 0 ? `${names.join(", ")} (+${remaining})` : names.join(", ");
  return translate("bundleSetupRequired", {
    count: dependencies.length,
    resources,
  });
}
