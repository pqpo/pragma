import { useCallback, useState } from "react";

export interface SidebarWidthPreference {
  readonly storageKey: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
}

export const SIDEBAR_WIDTH_PREFERENCES = {
  main: {
    storageKey: "pragma.desktop.sidebar.width.main",
    defaultWidth: 240,
    minWidth: 200,
    maxWidth: 360,
  },
  missions: {
    storageKey: "pragma.desktop.sidebar.width.missions",
    defaultWidth: 300,
    minWidth: 240,
    maxWidth: 420,
  },
  studio: {
    storageKey: "pragma.desktop.sidebar.width.studio",
    defaultWidth: 242,
    minWidth: 200,
    maxWidth: 420,
  },
  evaluations: {
    storageKey: "pragma.desktop.sidebar.width.evaluations",
    defaultWidth: 242,
    minWidth: 200,
    maxWidth: 420,
  },
  settings: {
    storageKey: "pragma.desktop.sidebar.width.settings",
    defaultWidth: 242,
    minWidth: 200,
    maxWidth: 420,
  },
} as const satisfies Record<string, SidebarWidthPreference>;

type SidebarWidthReader = Pick<Storage, "getItem">;
type SidebarWidthWriter = Pick<Storage, "setItem">;

export function clampSidebarWidth(width: number, preference: SidebarWidthPreference): number {
  if (!Number.isFinite(width)) return preference.defaultWidth;
  return Math.min(preference.maxWidth, Math.max(preference.minWidth, Math.round(width)));
}

export function readSidebarWidth(
  storage: SidebarWidthReader | undefined,
  preference: SidebarWidthPreference,
): number {
  try {
    const stored = storage?.getItem(preference.storageKey);
    if (stored === undefined || stored === null || stored.trim() === "") {
      return preference.defaultWidth;
    }
    const width = Number(stored);
    return Number.isFinite(width) ? clampSidebarWidth(width, preference) : preference.defaultWidth;
  } catch {
    return preference.defaultWidth;
  }
}

export function writeSidebarWidth(
  storage: SidebarWidthWriter | undefined,
  width: number,
  preference: SidebarWidthPreference,
): void {
  try {
    storage?.setItem(preference.storageKey, String(clampSidebarWidth(width, preference)));
  } catch {
    // A storage failure must not prevent resizing for the current session.
  }
}

export function usePersistentSidebarWidth(
  preference: SidebarWidthPreference,
): readonly [number, (width: number) => void] {
  const [width, setWidth] = useState(() =>
    readSidebarWidth(typeof window === "undefined" ? undefined : window.localStorage, preference),
  );

  const updateWidth = useCallback(
    (nextWidth: number) => {
      const clampedWidth = clampSidebarWidth(nextWidth, preference);
      setWidth(clampedWidth);
      writeSidebarWidth(
        typeof window === "undefined" ? undefined : window.localStorage,
        clampedWidth,
        preference,
      );
    },
    [preference],
  );

  return [width, updateWidth] as const;
}
