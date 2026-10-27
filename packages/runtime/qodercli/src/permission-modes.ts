import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "bypassPermissions",
  modes: [
    {
      id: "bypassPermissions",
      label: "Run without approval",
      description:
        "For autonomous execution. Skips Qoder tool permission prompts, including file changes and commands. This mode does not add a workspace sandbox.",
      defaultMcpApproval: "none",
      available: true,
    },
    {
      id: "default",
      label: "Ask when permission is needed",
      description:
        "For keeping control of actions. Qoder applies its permission rules and forwards actions that need approval to you; this does not mean every operation asks.",
      available: true,
    },
    {
      id: "auto",
      label: "Let Qoder decide permissions",
      description:
        "For reducing manual prompts. Qoder decides which actions can run directly; requests it forwards still need your approval. Actions may be denied. This is not full access or a read-only mode.",
      available: true,
    },
  ],
};
