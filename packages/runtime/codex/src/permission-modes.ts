import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "full-access",
  modes: [
    {
      id: "full-access",
      label: "Full access",
      description: "Native full access; managed tools retain their own approval policies.",
      defaultMcpApproval: "none",
      available: true,
    },
    {
      id: "request-approval",
      label: "Ask for approval",
      description: "Workspace sandbox; native escalation requests go to the user.",
      available: true,
    },
    {
      id: "read-only",
      label: "Read only",
      description:
        "Native read-only sandbox; escalation is disabled. MCP tools have separate policies.",
      available: true,
    },
    {
      id: "auto-review",
      label: "Approve for me",
      description: "Native reviewer for sandbox escalations.",
      available: false,
      reason: "Native approval reviewer integration is not connected.",
    },
  ],
};
