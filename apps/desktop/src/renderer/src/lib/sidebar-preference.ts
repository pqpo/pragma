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
