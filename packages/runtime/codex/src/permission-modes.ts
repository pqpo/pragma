import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "full-access",
  modes: [
    {
      id: "full-access",
      label: "Full access without approval",
      description:
        "For tasks that need unrestricted host access. Files and commands run without a sandbox or runtime approval; access is still limited by the host account permissions.",
      defaultMcpApproval: "none",
      available: true,
    },
    {
      id: "request-approval",
      label: "Workspace sandbox; ask to expand",
      description:
        "For everyday development. Can edit workspace files and run permitted commands without asking each time. Requests approval when broader access is needed; declining keeps the sandbox restrictions.",
      available: true,
    },
    {
      id: "read-only",
      label: "Read only; no file changes",
      description:
        "For reviewing code or investigating files. Native tools and commands run in a read-only sandbox and cannot write files or request broader access. Managed MCP tools have separate policies.",
      available: true,
    },
    {
      id: "auto-review",
      label: "Automatically review sandbox requests",
      description:
        "Would review requests to expand sandbox access for you. This integration is not connected, so this option cannot currently be selected.",
      available: false,
      reason: "Native approval reviewer integration is not connected.",
    },
  ],
};
