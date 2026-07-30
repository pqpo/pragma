import {
  PRAGMA_COMPILER_READ_VERSIONS,
  PRAGMA_COMPILER_WRITE_VERSION,
} from "@pragma/interpreter/ast";

import type { DesktopResolvedLocale } from "../../../shared/contracts/index.ts";
import { resolveDesktopLocale } from "../../../shared/desktop-locale.ts";

export type DesktopStartupErrorCode =
  | "DESKTOP_BRIDGE_UNAVAILABLE"
  | "DESKTOP_COMPONENT_VERSION_MISMATCH";

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
          readonly interpreter?:
            | {
                readonly writeVersion: string;
                readonly readVersions: readonly string[];
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
    const interpreter = snapshot.interpreter;
    if (
      interpreter === undefined ||
      interpreter.writeVersion !== PRAGMA_COMPILER_WRITE_VERSION ||
      interpreter.readVersions.length !== PRAGMA_COMPILER_READ_VERSIONS.length ||
      interpreter.readVersions.some(
        (version, index) => version !== PRAGMA_COMPILER_READ_VERSIONS[index],
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
