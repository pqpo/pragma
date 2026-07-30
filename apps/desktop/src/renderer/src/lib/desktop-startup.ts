import {
  PRAGMA_COMPILER_DIRECT_READ_VERSIONS,
  PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS,
  PRAGMA_COMPILER_WRITE_VERSION,
} from "@pragma/interpreter/ast";

import type { DesktopResolvedLocale } from "../../../shared/contracts/index.ts";
import { resolveDesktopLocale } from "../../../shared/desktop-locale.ts";

export type DesktopStartupErrorCode =
  | "DESKTOP_BRIDGE_UNAVAILABLE"
  | "DESKTOP_COMPONENT_VERSION_MISMATCH"
  | "DESKTOP_MAIN_INITIALIZATION_FAILED";

export type DesktopStartupResult =
  | {
      readonly locale: DesktopResolvedLocale;
      readonly errorCode: DesktopStartupErrorCode;
    }
  | {
      readonly locale: DesktopResolvedLocale;
      readonly settingsError?: unknown;
    };

export async function resolveDesktopStartup(
  bridge:
    | {
        getBridgeSnapshot?(): Promise<{
          readonly startup:
            | { readonly status: "ready" }
            | {
                readonly status: "failed";
                readonly code: "DESKTOP_MAIN_INITIALIZATION_FAILED";
              };
          readonly interpreter?:
            | {
                readonly writeVersion: string;
                readonly directReadVersions: readonly string[];
                readonly upgradeFromVersions: readonly string[];
              }
            | undefined;
        }>;
        getDesktopSettings(): Promise<{ readonly resolvedLocale: DesktopResolvedLocale }>;
      }
    | undefined,
  preferredSystemLanguages: readonly string[],
): Promise<DesktopStartupResult> {
  const fallbackLocale = resolveDesktopLocale(preferredSystemLanguages);
  if (bridge === undefined) {
    return {
      locale: fallbackLocale,
      errorCode: "DESKTOP_BRIDGE_UNAVAILABLE",
    };
  }
  if (typeof bridge.getBridgeSnapshot !== "function") {
    return {
      locale: fallbackLocale,
      errorCode: "DESKTOP_COMPONENT_VERSION_MISMATCH",
    };
  }

  try {
    const snapshot = await bridge.getBridgeSnapshot();
    if (snapshot.startup.status === "failed") {
      return {
        locale: fallbackLocale,
        errorCode: snapshot.startup.code,
      };
    }
    const interpreter = snapshot.interpreter;
    if (
      interpreter === undefined ||
      interpreter.writeVersion !== PRAGMA_COMPILER_WRITE_VERSION ||
      interpreter.directReadVersions.length !== PRAGMA_COMPILER_DIRECT_READ_VERSIONS.length ||
      interpreter.directReadVersions.some(
        (version, index) => version !== PRAGMA_COMPILER_DIRECT_READ_VERSIONS[index],
      ) ||
      interpreter.upgradeFromVersions.length !== PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS.length ||
      interpreter.upgradeFromVersions.some(
        (version, index) => version !== PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS[index],
      )
    ) {
      return {
        locale: fallbackLocale,
        errorCode: "DESKTOP_COMPONENT_VERSION_MISMATCH",
      };
    }
  } catch {
    return {
      locale: fallbackLocale,
      errorCode: "DESKTOP_BRIDGE_UNAVAILABLE",
    };
  }

  try {
    return {
      locale: (await bridge.getDesktopSettings()).resolvedLocale,
    };
  } catch (settingsError) {
    return {
      locale: fallbackLocale,
      settingsError,
    };
  }
}
