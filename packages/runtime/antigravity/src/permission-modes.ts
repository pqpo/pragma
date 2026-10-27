import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "full-access",
  modes: [
    {
      id: "full-access",
      label: "Full access without approval",
      description:
        "For direct execution. Allows native file and command tools without asking, using host permissions; the native command sandbox is not enabled.",
      defaultMcpApproval: "none",
      available: true,
    },
    {
      id: "request-approval",
      label: "Ask before changes and commands",
      description:
        "For reviewing changes yourself. Known read tools in allowed directories run directly; file changes, commands and other non-read actions require your approval. Native command sandboxing is also enabled; approval does not remove its restrictions.",
      available: true,
    },
    {
      id: "native-auto",
      label: "Automatically review sandbox requests",
      description:
        "Would use the runtime’s automatic reviewer for sandbox requests. This integration is not connected, so this option cannot currently be selected.",
      available: false,
      reason: "Native approval reviewer integration is not connected.",
    },
  ],
};
