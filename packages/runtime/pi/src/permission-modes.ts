import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "full-access",
  modes: [
    {
      id: "full-access",
      label: "Run with host permissions",
      description:
        "For direct execution using the host account. Can read and write files and run commands without native approval, including network or external-file access allowed by the host. Pi provides no built-in sandbox; this is its only available mode.",
      defaultMcpApproval: "none",
      available: true,
    },
  ],
};
