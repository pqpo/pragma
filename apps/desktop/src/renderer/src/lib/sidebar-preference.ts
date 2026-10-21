import { z } from "zod";

const sidebarCollapsedStorageKey = "pragma.desktop.sidebar.collapsed";

type SidebarPreferenceReader = Pick<Storage, "getItem">;
type SidebarPreferenceWriter = Pick<Storage, "setItem">;

export function readSidebarCollapsed(storage: SidebarPreferenceReader | undefined): boolean {
  try {
    return storage?.getItem(sidebarCollapsedStorageKey) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(
  storage: SidebarPreferenceWriter | undefined,
  collapsed: boolean,
): void {
  try {
    storage?.setItem(sidebarCollapsedStorageKey, String(collapsed));
  } catch {
    // A storage failure should not prevent the sidebar from being toggled for this session.
  }
}

const pinnedNavigationStorageKey = "pragma.desktop.sidebar.pinned-navigation";
const pinnedNavigationSchema = z.array(z.enum(["market", "evaluations", "usage", "settings"]));
type PinnedNavigation = z.infer<typeof pinnedNavigationSchema>;

export function readPinnedNavigation(): PinnedNavigation {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(pinnedNavigationStorageKey) ?? "[]",
    );
    const result = pinnedNavigationSchema.safeParse(value);
    return result.success ? [...new Set(result.data)] : [];
  } catch {
    return [];
  }
}

export function writePinnedNavigation(items: PinnedNavigation): void {
  try {
    window.localStorage.setItem(pinnedNavigationStorageKey, JSON.stringify(items));
  } catch {
    // Keep pinning usable for this session when storage is unavailable.
  }
}
