import type { RuntimePermissionCatalog } from "@pragma/shared";

export const permissionModes: RuntimePermissionCatalog = {
  defaultModeId: "bypassPermissions",
  modes: [
    {
      id: "bypassPermissions",
      label: "Run without approval",
      description:
        "For autonomous execution. Skips Claude Code tool permission prompts, including file changes and commands. This mode does not add a workspace sandbox.",
      defaultMcpApproval: "none",
      available: true,
    },
    {
      id: "default",
      label: "Ask when permission is needed",
      description:
        "For keeping control of actions. Claude Code allows actions covered by its rules and asks you about actions that need permission; it does not ask before every read or command.",
      available: true,
    },
    {
      id: "auto",
      label: "Automatic risk review",
      description:
        "For reducing manual prompts. Claude Code reviews action risks and may allow, deny or ask you to decide. Requires a supported model and runtime; unsupported models may fall back to accepting file edits without approval.",
      available: true,
    },
  ],
};
