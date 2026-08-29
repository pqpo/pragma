import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";

import type { WorkspaceFilesystemPort } from "@pragma/local-host";

/** Desktop's low-level filesystem adapter for the Local Host workspace use case. */
export function createWorkspaceFilesystemPort(): WorkspaceFilesystemPort {
  return {
    stat: async (path) => await stat(path),
    access: async (path, mode) =>
      await access(path, mode === "read" ? fsConstants.R_OK : fsConstants.W_OK),
    realpath: async (path) => await realpath(path),
  };
}
