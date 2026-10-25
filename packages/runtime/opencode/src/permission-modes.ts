import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "full-access",
  modes: [
    {
      id: "full-access",
      label: "Allow all tools",
      description: "Native allow rules; explicit deny policies remain enforced.",
      available: true,
    },
    {
      id: "request-approval",
      label: "Ask for approval",
      description: "Edits and web requests ask; shell and external directories are disabled.",
      available: true,
    },
    {
      id: "auto-approve",
      label: "Accept edits",
      description:
        "Workspace edits are allowed; shell, external directories and unknown requests are denied.",
      available: true,
    },
  ],
};
