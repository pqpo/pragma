import { createHash } from "node:crypto";

import { integrationErrorExitCode } from "@pragma/shared/integration";
import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_HOST_APPLICATION_PROTOCOL,
  LOCAL_HOST_SHARED_BOARD_SCOPE_ID,
  LOCAL_HOST_SHARED_BOARD_STORE_ID,
  createLocalHostApplication,
  type WorkspaceFilesystemPort,
} from "../src/index.ts";

describe("LocalHostApplication", () => {
  it("owns the canonical workspace resolution use case", async () => {
    const application = createApplication({
      filesystem: filesystemFor({
        canonicalPath: "/workspaces/pragma",
      }),
    });

    await expect(application.resolveWorkspace("/aliases/pragma")).resolves.toEqual({
      schemaVersion: "pragma.integration-workspace/v1",
      requestedPath: "/aliases/pragma",
      canonicalPath: "/workspaces/pragma",
      displayName: "pragma",
      identityHash: `sha256:${createHash("sha256").update("/workspaces/pragma").digest("hex")}`,
      access: { exists: true, readable: true, writable: true },
      source: "explicit",
    });
  });

  it.each([
    ["relative", "workspace", filesystemFor(), "INVALID_ARGUMENT", 2],
    [
      "not found",
      "/missing",
      filesystemFor({ statError: nodeError("ENOENT") }),
      "WORKSPACE_NOT_FOUND",
      3,
    ],
    ["not a directory", "/file", filesystemFor({ isDirectory: false }), "INVALID_ARGUMENT", 2],
    [
      "not readable",
      "/workspace",
      filesystemFor({ readError: nodeError("EACCES") }),
      "WORKSPACE_ACCESS_DENIED",
      6,
    ],
    [
      "not writable",
      "/workspace",
      filesystemFor({ writeError: nodeError("EACCES") }),
      "WORKSPACE_ACCESS_DENIED",
      6,
    ],
  ] as const)(
    "maps %s workspaces to a stable integration error",
    async (_name, requestedPath, filesystem, code, exitCode) => {
      const application = createApplication({ filesystem });

      await expect(application.resolveWorkspace(requestedPath)).rejects.toMatchObject({
        schemaVersion: "pragma.integration-error/v1",
        code,
        retryable: false,
      });
      expect(integrationErrorExitCode(code)).toBe(exitCode);
    },
  );

  it("routes canonical catalog and Mission queries through the application contract", async () => {
    const listMissions = vi.fn(async () => [{ id: "mission-1", title: "Fixture Mission" }]);
    const application = createApplication({ listMissions });

    expect(application.protocol).toBe(LOCAL_HOST_APPLICATION_PROTOCOL);
    await expect(application.listProjects()).resolves.toEqual([{ id: "project-1" }]);
    await expect(application.getProjectRevision("project-1", 2)).resolves.toEqual({
      id: "project-1",
      revision: 2,
    });
    await expect(application.getMission("mission-1")).resolves.toEqual({ id: "mission-1" });
    await expect(application.listMissions()).resolves.toEqual([
      { id: "mission-1", title: "Fixture Mission" },
    ]);
    expect(listMissions).toHaveBeenCalledOnce();
  });

  it("fixes Board reads to the shared scope and exposes no private Board operation", async () => {
    const requests: unknown[] = [];
    const application = createApplication({
      board: {
        list: async (input) => {
          requests.push(input);
          return { items: [] };
        },
        read: async (input) => {
          requests.push(input);
          return { id: input.id };
        },
        search: async (input) => {
          requests.push(input);
          return { matches: [] };
        },
      },
    });

    await application.listSharedBoard("mission-1");
    await application.readSharedBoard("mission-1", "handoffs/m3.md", 0, 200);
    await application.searchSharedBoard("mission-1", "M3", 10);

    expect(requests).toEqual([
      {
        missionId: "mission-1",
        storeId: LOCAL_HOST_SHARED_BOARD_STORE_ID,
        scopeId: LOCAL_HOST_SHARED_BOARD_SCOPE_ID,
      },
      {
        missionId: "mission-1",
        storeId: LOCAL_HOST_SHARED_BOARD_STORE_ID,
        scopeId: LOCAL_HOST_SHARED_BOARD_SCOPE_ID,
        id: "handoffs/m3.md",
        start: 0,
        maxBytes: 200,
      },
      {
        missionId: "mission-1",
        storeId: LOCAL_HOST_SHARED_BOARD_STORE_ID,
        scopeId: LOCAL_HOST_SHARED_BOARD_SCOPE_ID,
        query: "M3",
        maxResults: 10,
        contextLines: 2,
      },
    ]);
    expect("listPrivateBoard" in application).toBe(false);
  });
});

function createApplication(
  options: {
    readonly filesystem?: WorkspaceFilesystemPort;
    readonly listMissions?: () => Promise<
      readonly { readonly id: string; readonly title: string }[]
    >;
    readonly board?: {
      readonly list: (input: unknown) => Promise<unknown>;
      readonly read: (input: { readonly id: string }) => Promise<unknown>;
      readonly search: (input: unknown) => Promise<unknown>;
    };
  } = {},
) {
  return createLocalHostApplication({
    integrationCapability: async () => ({
      schemaVersion: "pragma.integration-capability/v1",
      protocol: "pragma.integration/v1",
      readableVersions: ["pragma.integration/v1"],
      migratableFromVersions: [],
      features: ["query"],
    }),
    catalog: {
      listProjects: async () => [{ id: "project-1" }],
      getProjectRevision: async (id, revision) => ({ id, revision }),
      listExecutors: async () => [{ ref: "expert:catalog" }],
    },
    missions: {
      get: async (id) => ({ id }),
      list: options.listMissions ?? (async () => [{ id: "mission-1", title: "Fixture Mission" }]),
    },
    workspace: options.filesystem ?? filesystemFor(),
    board: options.board ?? {
      list: async () => ({ items: [] }),
      read: async (input) => ({ id: input.id }),
      search: async () => ({ matches: [] }),
    },
    runtime: { resolver: {} as never },
  });
}

function filesystemFor(
  options: {
    readonly canonicalPath?: string;
    readonly isDirectory?: boolean;
    readonly statError?: Error;
    readonly readError?: Error;
    readonly writeError?: Error;
  } = {},
): WorkspaceFilesystemPort {
  return {
    stat: async () => {
      if (options.statError) throw options.statError;
      return { isDirectory: () => options.isDirectory ?? true };
    },
    access: async (_path, mode) => {
      if (mode === "read" && options.readError) throw options.readError;
      if (mode === "write" && options.writeError) throw options.writeError;
    },
    realpath: async () => options.canonicalPath ?? "/workspace",
  };
}

function nodeError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}
