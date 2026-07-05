import { app } from "electron";

import type { DesktopBridgeSnapshot } from "../shared/desktop-api.ts";

function normalizeOs(): DesktopBridgeSnapshot["app"]["os"] {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return "unknown";
}

export function createBridgeSnapshot(): DesktopBridgeSnapshot {
  return {
    app: {
      name: "Pragma Desktop",
      version: app.getVersion(),
      os: normalizeOs(),
    },
    gateway: {
      schemaVersion: 1,
      endpoint: process.env.PRAGMA_RUNTIME_GATEWAY_URL || "ws://localhost:3001/runtime-gateway",
      transport: "websocket",
    },
    device: {
      status: "offline",
      label: "Local device session",
    },
    workspace: {
      path: null,
      status: "unset",
    },
    capabilities: [
      { id: "codex", label: "Codex", status: "not_configured" },
      { id: "claude-code", label: "Claude Code", status: "not_configured" },
      { id: "self-hosted-agent", label: "Self-hosted Agent", status: "not_configured" },
    ],
  };
}
