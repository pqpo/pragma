import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "full-access",
  modes: [
    {
      id: "full-access",
      label: "Full access",
      description: "Native host access with managed MCP policies.",
      defaultMcpApproval: "none",
      available: true,
    },
    {
      id: "request-approval",
      label: "Ask for approval",
      description:
        "Pragma Host Hook compatibility bridge forwards non-read operations for approval.",
      available: true,
    },
    {
      id: "native-auto",
      label: "Auto",
      description: "Native sandbox escalation review.",
      available: false,
      reason: "Native approval reviewer integration is not connected.",
    },
  ],
};
