import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { PragmaPaths, encodePragmaPathSegment, type HostContextBindings } from "@pragma/core";
import { FileSystemContextStore } from "@pragma/context-filesystem";

import { createMissionBoard } from "./mission-board-capability.ts";

export * from "./mission-board-capability.ts";

const BOARD_INCLUDE = ["*.md", "**/*.md", "*.json", "**/*.json", "*.txt", "**/*.txt"] as const;

/**
 * Creates the Mission-scoped Context bindings used by a local run.
 *
 * The binding is resolved per Mission so concurrent CLI runs never share a
 * ContextSystem identity.  The overflow target is the shared Mission Board;
 * `ContextOutputService` therefore writes `system/outputs/` outside the
 * workspace while retaining only a controlled Context reference in Core.
 */
export async function createLocalHostMissionBoardBindings(options: {
  readonly pragmaHome?: string | undefined;
  readonly missionId: string;
}): Promise<HostContextBindings> {
  const paths = new PragmaPaths({ pragmaHome: options.pragmaHome });
  const missionRoot = join(
    paths.missionsRoot(),
    encodePragmaPathSegment(options.missionId),
    "board",
  );
  const openStore = async (rootDir: string): Promise<FileSystemContextStore> => {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    return new FileSystemContextStore({ rootDir, include: BOARD_INCLUDE });
  };

  const board = await createMissionBoard({
    ownerId: options.missionId,
    openSharedStore: async () => await openStore(join(missionRoot, "shared")),
    openPrivateStore: async (_ownerId, contextId) =>
      await openStore(join(missionRoot, "private", encodePragmaPathSegment(contextId))),
  });
  return board.bindings;
}
