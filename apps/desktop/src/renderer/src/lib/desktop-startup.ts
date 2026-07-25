import type { DesktopResolvedLocale } from "../../../shared/desktop-api.ts";
import { resolveDesktopLocale } from "../../../shared/desktop-locale.ts";

export type DesktopStartupErrorCode = "DESKTOP_BRIDGE_UNAVAILABLE";

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
