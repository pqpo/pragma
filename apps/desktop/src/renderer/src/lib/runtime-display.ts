import type { TFunction } from "i18next";

export const BUILT_IN_RUNTIME_ID = "pi";
export const BUILT_IN_RUNTIME_CANONICAL_NAME = "Built-in Runtime";

export interface RuntimeDisplayIdentity {
  readonly id: string;
  readonly displayName: string;
}

export function isBuiltInRuntime(runtime: Pick<RuntimeDisplayIdentity, "id">): boolean {
  return runtime.id === BUILT_IN_RUNTIME_ID;
}

export function runtimeDisplayName(
  t: TFunction,
  runtime: RuntimeDisplayIdentity,
): string {
  return isBuiltInRuntime(runtime)
    ? t("runtimeNames.builtIn", { ns: "common" })
    : runtime.displayName;
}

export function canonicalRuntimeDisplayName(runtime: RuntimeDisplayIdentity): string {
  return isBuiltInRuntime(runtime)
    ? BUILT_IN_RUNTIME_CANONICAL_NAME
    : runtime.displayName;
}
