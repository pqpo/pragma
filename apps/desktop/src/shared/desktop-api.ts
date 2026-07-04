export interface DesktopAppInfo {
  name: "Pragma Desktop";
  version: string;
  os: "macos" | "windows" | "linux" | "unknown";
}

export interface RuntimeGatewayConfig {
  schemaVersion: 1;
  endpoint: string;
  transport: "websocket";
}

export interface LocalRuntimeCapability {
  id: "codex" | "claude-code" | "self-hosted-agent";
  label: string;
  status: "available" | "not_configured";
}

export interface DesktopBridgeSnapshot {
  app: DesktopAppInfo;
  gateway: RuntimeGatewayConfig;
  device: {
    status: "offline";
    label: string;
  };
  workspace: {
    path: string | null;
    status: "unset" | "ready";
  };
  capabilities: LocalRuntimeCapability[];
}

export interface PickWorkspaceResult {
  ok: boolean;
  path?: string;
  basename?: string;
  reason?: "cancelled" | "no_window" | "not_directory" | "not_accessible" | "error";
  error?: string;
}

export interface ValidateWorkspaceResult {
  ok: boolean;
  reason?: "not_absolute" | "not_found" | "not_directory" | "not_readable" | "not_writable" | "error";
  error?: string;
}

export interface PragmaDesktopAPI {
  getBridgeSnapshot: () => Promise<DesktopBridgeSnapshot>;
  pickWorkspace: () => Promise<PickWorkspaceResult>;
  validateWorkspace: (path: string) => Promise<ValidateWorkspaceResult>;
}
