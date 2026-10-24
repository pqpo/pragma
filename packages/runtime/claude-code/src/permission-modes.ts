import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "bypassPermissions",
  modes: [
    {
      id: "bypassPermissions",
      label: "Bypass permissions",
      description: "Native permission bypass; managed tool policies still apply.",
      available: true,
    },
    {
      id: "default",
      label: "Default",
      description: "Native permission requests are forwarded to the user.",
      available: true,
    },
    {
      id: "auto",
      label: "Auto",
      description: "Native classifier reviews actions; requires runtime support.",
      available: true,
    },
  ],
};
