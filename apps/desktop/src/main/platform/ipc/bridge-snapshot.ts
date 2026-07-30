import { app } from "electron";
import {
  PRAGMA_COMPILER_DIRECT_READ_VERSIONS,
  PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS,
  PRAGMA_COMPILER_WRITE_VERSION,
} from "@pragma/interpreter/ast";

import type { DesktopBridgeSnapshot } from "../../../shared/contracts/index.ts";

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
    interpreter: {
      writeVersion: PRAGMA_COMPILER_WRITE_VERSION,
      directReadVersions: [...PRAGMA_COMPILER_DIRECT_READ_VERSIONS],
      upgradeFromVersions: [...PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS],
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
