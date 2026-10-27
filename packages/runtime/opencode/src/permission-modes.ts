import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "full-access",
  modes: [
    {
      id: "full-access",
      label: "Allow all tools",
      description: "Native allow rules; explicit deny policies remain enforced.",
      defaultMcpApproval: "none",
      available: true,
    },
    {
      id: "request-approval",
      label: "Ask for approval",
      description:
        "Asks before edits, commands and web requests. Direct external directory access is restricted except runtime skills; approved commands are not sandboxed.",
      available: true,
    },
    {
      id: "auto-approve",
      label: "Edit and run commands",
      description:
        "Edits and commands run without approval. Web tools and direct external directory access are blocked except runtime skills. Commands are not sandboxed and can access the network and external files; explicit deny rules still apply.",
      available: true,
    },
  ],
};
