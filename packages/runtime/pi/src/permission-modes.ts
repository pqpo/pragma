import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "full-access",
  modes: [
    {
      id: "full-access",
      label: "Native execution / full access",
      description:
        "Uses host process permissions. Pi has no built-in tool approval or sandbox policy.",
      available: true,
    },
  ],
};
